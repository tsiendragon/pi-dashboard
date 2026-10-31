package com.sam.pidash.data.local

import com.sam.pidash.data.remote.pidashJson
import com.sam.pidash.data.remote.validateLiveBaseUrl
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.LiveClaim
import com.sam.pidash.domain.model.LiveDetail
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.security.MessageDigest

/**
 * Identity of one cached Live transcript.
 *
 * Only digests of the edge credential and the current HttpOnly Live cookie are
 * kept in the key. Neither secret is ever written to disk, and changing either
 * one makes every older snapshot unreadable.
 */
data class LiveDetailCacheKey(
    val backendId: String,
    val origin: String,
    val edgeCredentialDigest: String,
    val liveCookieDigest: String,
    val processInstanceId: String,
) {
    internal fun storageId(): String = sha256(
        listOf(backendId, origin, edgeCredentialDigest, liveCookieDigest, processInstanceId)
            .joinToString("\n"),
    )

    internal fun backendStorageId(): String = sha256(backendId)

    override fun toString(): String =
        "LiveDetailCacheKey(backendId=$backendId, processInstanceId=$processInstanceId)"
}

/** A decrypted, still-valid summary of what is on disk. */
data class LiveCachedDetail(
    val detail: LiveDetail,
    val savedAt: Long,
    val expiresAt: Long,
    val truncated: Boolean,
)

/** Presence in repository state means `details[key]` came from disk, not from the server. */
data class LiveDetailCacheSource(
    val savedAt: Long,
    val expiresAt: Long,
    val truncated: Boolean,
)

data class LiveDetailCacheLimits(
    val ttlMillis: Long = 7L * 24 * 60 * 60 * 1000,
    val maxEntries: Int = 32,
    val maxTotalBytes: Long = 8L * 1024 * 1024,
    val maxEntryBytes: Int = 1536 * 1024,
)

/** Cache operations never fall back to plaintext and never return executable UI/lease state. */
interface LiveDetailCache {
    suspend fun load(key: LiveDetailCacheKey, now: Long = System.currentTimeMillis()): LiveCachedDetail?
    suspend fun save(key: LiveDetailCacheKey, detail: LiveDetail, now: Long = System.currentTimeMillis()): Boolean
    suspend fun remove(key: LiveDetailCacheKey)
    suspend fun clearBackend(backendId: String)
}

object NoLiveDetailCache : LiveDetailCache {
    override suspend fun load(key: LiveDetailCacheKey, now: Long): LiveCachedDetail? = null
    override suspend fun save(key: LiveDetailCacheKey, detail: LiveDetail, now: Long): Boolean = false
    override suspend fun remove(key: LiveDetailCacheKey) = Unit
    override suspend fun clearBackend(backendId: String) = Unit
}

/** Same origin derivation as the Live client: scheme + authority, no path/query/fragment. */
internal fun liveDetailOrigin(baseUrl: String): String =
    validateLiveBaseUrl(baseUrl).newBuilder()
        .encodedPath("/").query(null).fragment(null).build()
        .toString().trimEnd('/')

/**
 * Build a cache key from the *current* backend/edge credential and Live cookie.
 * A null cookie means the installation is not authorized, so there is no key and
 * no cache read/write is attempted (e.g. after 401 or logout).
 */
internal fun liveDetailCacheKey(
    backend: Backend,
    cookie: String?,
    processInstanceId: String,
    origin: String = liveDetailOrigin(backend.baseUrl),
): LiveDetailCacheKey? {
    if (cookie.isNullOrBlank()) return null
    require(processInstanceId.matches(Regex("[A-Za-z0-9_.:-]{1,256}"))) { "Invalid Live process id" }
    return LiveDetailCacheKey(
        backendId = backend.id,
        origin = origin,
        edgeCredentialDigest = sha256(backend.token),
        liveCookieDigest = sha256(cookie),
        processInstanceId = processInstanceId,
    )
}

/** Remove image payloads, executable UI and control leases before anything reaches disk. */
internal fun sanitizeLiveDetailForCache(detail: LiveDetail): LiveDetail = detail.copy(
    summary = detail.summary.copy(claim = LiveClaim()),
    entries = detail.entries.map(::withoutImagePayloads),
    goal = detail.goal?.let(::withoutImagePayloads),
    pendingUi = emptyList(),
)

private fun withoutImagePayloads(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> {
        if ((value["type"] as? JsonPrimitive)?.contentOrNull == "image") {
            JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive("[图片未缓存]")))
        } else JsonObject(value.mapValues { withoutImagePayloads(it.value) })
    }
    is JsonArray -> JsonArray(value.map(::withoutImagePayloads))
    else -> value
}

internal data class PreparedLiveDetail(
    val detail: LiveDetail,
    val truncated: Boolean,
)

/**
 * Keep the most recent transcript suffix that fits. Older entries are dropped
 * first; the newest entries and the summary are retained whenever they fit.
 */
internal fun prepareLiveDetailForCache(
    detail: LiveDetail,
    maxBytes: Int = LiveDetailCacheLimits().maxEntryBytes - ENVELOPE_RESERVE_BYTES,
): PreparedLiveDetail {
    val sanitized = sanitizeLiveDetailForCache(detail)
    require(maxBytes > 0)
    var entries = sanitized.entries
    fun encodedSize(candidate: LiveDetail): Int =
        pidashJson.encodeToString(LiveDetail.serializer(), candidate).toByteArray(Charsets.UTF_8).size

    var size = encodedSize(sanitized)
    while (size > maxBytes && entries.isNotEmpty()) {
        val excess = size - maxBytes
        var droppedBytes = 0
        var drop = 0
        while (drop < entries.size && droppedBytes < excess) {
            droppedBytes += pidashJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), entries[drop])
                .toByteArray(Charsets.UTF_8).size
            drop++
        }
        entries = entries.drop(drop.coerceAtLeast(1))
        size = encodedSize(sanitized.copy(entries = entries))
    }
    return PreparedLiveDetail(
        detail = sanitized.copy(entries = entries),
        truncated = entries.size != sanitized.entries.size || sanitized.entries != detail.entries || sanitized.goal != detail.goal,
    )
}

@Serializable
internal data class CachedLiveDetailEnvelope(
    val version: Int = 1,
    val keyId: String,
    val processInstanceId: String,
    val sessionId: String,
    val savedAt: Long,
    val expiresAt: Long,
    val truncated: Boolean,
    val detail: LiveDetail,
)

internal const val ENVELOPE_RESERVE_BYTES = 4096

internal fun sha256(text: String): String = MessageDigest.getInstance("SHA-256")
    .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
