package com.sam.pidash.data.local

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.sam.pidash.data.remote.pidashJson
import com.sam.pidash.domain.model.LiveDetail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Authenticated encryption boundary; tests inject a JVM AES-GCM implementation. */
interface LiveDetailCipher {
    fun encrypt(plaintext: ByteArray, aad: ByteArray): ByteArray
    fun decrypt(ciphertext: ByteArray, aad: ByteArray): ByteArray
}

/** AES-GCM with the key supplied by AndroidKeyStore in production. */
class AesGcmLiveDetailCipher(private val keyProvider: () -> SecretKey) : LiveDetailCipher {
    override fun encrypt(plaintext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keyProvider())
        cipher.updateAAD(aad)
        val encrypted = cipher.doFinal(plaintext)
        val iv = cipher.iv
        require(iv.size in 12..16) { "Unsupported GCM IV length" }
        return ByteArray(1 + iv.size + encrypted.size).also { out ->
            out[0] = iv.size.toByte()
            iv.copyInto(out, 1)
            encrypted.copyInto(out, 1 + iv.size)
        }
    }

    override fun decrypt(ciphertext: ByteArray, aad: ByteArray): ByteArray {
        require(ciphertext.size > 1)
        val ivLength = ciphertext[0].toInt() and 0xff
        require(ivLength in 12..16 && ciphertext.size > 1 + ivLength)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(128, ciphertext, 1, ivLength))
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertext, 1 + ivLength, ciphertext.size - 1 - ivLength)
    }
}

/**
 * Encrypted, application-private snapshot store.
 *
 * Layout is `noBackupFilesDir/live-detail-cache-v1/<hash(backendId)>/<hash(identity)>.bin`.
 * The file name contains no token/cookie/process text, and the payload is AES-GCM
 * ciphertext with the identity hash as AAD. A copy to another identity therefore
 * fails authentication instead of becoming readable.
 */
class EncryptedLiveDetailCache(
    private val root: File,
    private val cipher: LiveDetailCipher,
    private val limits: LiveDetailCacheLimits = LiveDetailCacheLimits(),
) : LiveDetailCache {

    constructor(context: Context) : this(
        root = File(context.noBackupFilesDir, ROOT_DIRECTORY),
        cipher = AesGcmLiveDetailCipher(::androidKeyStoreKey),
    )

    private val lock = Any()

    override suspend fun load(key: LiveDetailCacheKey, now: Long): LiveCachedDetail? = withContext(Dispatchers.IO) {
        synchronized(lock) {
            val file = fileFor(key)
            if (!file.isFile) return@synchronized null
            if (file.length() <= 0L || file.length() > limits.maxEntryBytes) {
                file.delete()
                return@synchronized null
            }
            try {
                val aad = key.storageId().toByteArray(Charsets.UTF_8)
                val plaintext = cipher.decrypt(file.readBytes(), aad)
                val envelope = pidashJson.decodeFromString(CachedLiveDetailEnvelope.serializer(), plaintext.toString(Charsets.UTF_8))
                val valid = envelope.version == 1 &&
                    envelope.keyId == key.storageId() &&
                    envelope.processInstanceId == key.processInstanceId &&
                    envelope.detail.summary.processInstanceId == key.processInstanceId &&
                    envelope.detail.summary.sessionId == envelope.sessionId &&
                    now >= envelope.savedAt &&
                    now - envelope.savedAt <= limits.ttlMillis &&
                    now <= envelope.expiresAt
                if (!valid) {
                    file.delete()
                    null
                } else {
                    val prepared = prepareLiveDetailForCache(envelope.detail, limits.maxEntryBytes - ENVELOPE_RESERVE_BYTES)
                    LiveCachedDetail(
                        detail = prepared.detail,
                        savedAt = envelope.savedAt,
                        expiresAt = envelope.expiresAt,
                        truncated = envelope.truncated || prepared.truncated,
                    )
                }
            } catch (_: Exception) {
                // Key loss, corruption, identity change or tampering: delete and require network.
                file.delete()
                null
            }
        }
    }

    override suspend fun save(key: LiveDetailCacheKey, detail: LiveDetail, now: Long): Boolean = withContext(Dispatchers.IO) {
        val maxDetailBytes = limits.maxEntryBytes - ENVELOPE_RESERVE_BYTES
        if (maxDetailBytes <= 0) return@withContext false
        val prepared = prepareLiveDetailForCache(detail, maxDetailBytes)
        val envelope = CachedLiveDetailEnvelope(
            keyId = key.storageId(),
            processInstanceId = key.processInstanceId,
            sessionId = prepared.detail.summary.sessionId,
            savedAt = now,
            expiresAt = now + limits.ttlMillis,
            truncated = prepared.truncated,
            detail = prepared.detail,
        )
        val plaintext = pidashJson.encodeToString(CachedLiveDetailEnvelope.serializer(), envelope)
            .toByteArray(Charsets.UTF_8)
        if (plaintext.size > limits.maxEntryBytes) return@withContext false
        val encrypted = try {
            cipher.encrypt(plaintext, key.storageId().toByteArray(Charsets.UTF_8))
        } catch (_: Exception) {
            return@withContext false // Never write an unencrypted fallback.
        }
        if (encrypted.size > limits.maxEntryBytes || encrypted.size > limits.maxTotalBytes) return@withContext false

        synchronized(lock) {
            try {
                val file = fileFor(key)
                val directory = file.parentFile ?: return@synchronized false
                if (!directory.isDirectory && !directory.mkdirs()) return@synchronized false
                pruneLocked(now, incomingBytes = encrypted.size.toLong(), replace = file)

                val temporary = File(directory, file.name + ".tmp")
                FileOutputStream(temporary).use { output ->
                    output.write(encrypted)
                    output.fd.sync()
                }
                try {
                    Files.move(
                        temporary.toPath(), file.toPath(),
                        StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE,
                    )
                } catch (_: Exception) {
                    Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
                file.setLastModified(now)
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    override suspend fun remove(key: LiveDetailCacheKey) = withContext(Dispatchers.IO) {
        synchronized(lock) { fileFor(key).delete(); Unit }
    }

    override suspend fun clearBackend(backendId: String) = withContext(Dispatchers.IO) {
        synchronized(lock) {
            File(root, sha256(backendId)).deleteRecursively()
            Unit
        }
    }

    private fun fileFor(key: LiveDetailCacheKey): File =
        File(File(root, key.backendStorageId()), key.storageId() + ".bin")

    /**
     * Expired files are removed first, then oldest files until both the global
     * entry-count and byte budgets fit the incoming snapshot. `replace` is the
     * target file whose old bytes will disappear during the atomic move.
     */
    private fun pruneLocked(now: Long, incomingBytes: Long, replace: File) {
        if (!root.isDirectory) return
        val files = root.walkTopDown()
            .filter { it.isFile && (it.name.endsWith(".bin") || it.name.endsWith(".tmp")) }
            .toList()
        files.forEach { file ->
            val age = now - file.lastModified()
            if (age > limits.ttlMillis || age < 0) file.delete()
        }
        val live = root.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".bin") }
            .filter { it.absolutePath != replace.absolutePath }
            .sortedBy { it.lastModified() }
            .toMutableList()
        var count = live.size
        var total = live.sumOf { it.length() }
        while (live.isNotEmpty() && (count + 1 > limits.maxEntries || total + incomingBytes > limits.maxTotalBytes)) {
            val oldest = live.removeAt(0)
            count--
            total -= oldest.length()
            oldest.delete()
        }
        root.walkTopDown().filter { it.isFile && it.name.endsWith(".tmp") && now - it.lastModified() > 60_000 }
            .forEach { it.delete() }
    }

    private companion object {
        const val ROOT_DIRECTORY = "live-detail-cache-v1"
        const val KEY_ALIAS = "pidash-live-detail-v1"

        @Synchronized
        fun androidKeyStoreKey(): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            return (store.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator
                .getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                            KEY_ALIAS,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setRandomizedEncryptionRequired(true)
                            .build(),
                    )
                }.generateKey()
        }
    }
}
