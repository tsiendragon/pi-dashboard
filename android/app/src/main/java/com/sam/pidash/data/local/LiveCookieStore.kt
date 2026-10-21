package com.sam.pidash.data.local

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.sam.pidash.domain.model.Backend
import java.io.IOException
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only the per-installation live cookie, never the host-wide control token. */
interface LiveCookieStore {
    fun load(backend: Backend): String?
    fun save(backend: Backend, cookie: String?)
}

internal fun liveCookieBinding(backend: Backend): String =
    backend.id + "\n" + backend.baseUrl.trim().trimEnd('/') + "\n" + digest(backend.token)

private fun digest(text: String): String = MessageDigest.getInstance("SHA-256")
    .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** AES-GCM key never leaves AndroidKeyStore. A changed origin/credential cannot reuse a cookie. */
class EncryptedLiveCookieStore(context: Context) : LiveCookieStore {
    private val prefs = context.getSharedPreferences("live_auth", Context.MODE_PRIVATE)
    private val lock = Any()
    private fun prefix(backend: Backend) = digest(backend.id) + ":"
    private fun name(backend: Backend) = prefix(backend) + digest(liveCookieBinding(backend))

    private fun key(): SecretKey = synchronized(lock) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator
            .getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply {
                init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true).build())
            }.generateKey()
    }

    override fun load(backend: Backend): String? = synchronized(lock) {
        val encoded = prefs.getString(name(backend), null) ?: return null
        try {
            val parts = encoded.split(':', limit = 2)
            require(parts.size == 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            cipher.updateAAD(liveCookieBinding(backend).toByteArray())
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
                .takeIf { COOKIE.matches(it) }
        } catch (_: Exception) {
            // Reinstall/key loss/corrupt ciphertext: require pairing, never use plaintext fallback.
            prefs.edit().remove(name(backend)).commit()
            null
        }
    }

    override fun save(backend: Backend, cookie: String?) = synchronized(lock) {
        val edit = prefs.edit()
        prefs.all.keys.filter { it.startsWith(prefix(backend)) }.forEach(edit::remove)
        if (cookie != null) {
            require(COOKIE.matches(cookie)) { "Invalid live authentication cookie" }
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key())
                cipher.updateAAD(liveCookieBinding(backend).toByteArray())
                edit.putString(name(backend), Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                    Base64.encodeToString(cipher.doFinal(cookie.toByteArray()), Base64.NO_WRAP))
            } catch (_: Exception) {
                throw IOException("无法安全保存 Live 授权；未使用明文存储")
            }
        }
        if (!edit.commit()) throw IOException("Live 授权存储失败")
        Unit
    }

    private companion object {
        const val ALIAS = "pidash-live-cookie-v1"
        val COOKIE = Regex("[a-f0-9]{64}")
    }
}
