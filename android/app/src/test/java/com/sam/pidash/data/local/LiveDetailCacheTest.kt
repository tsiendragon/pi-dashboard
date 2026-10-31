package com.sam.pidash.data.local

import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.LiveClaim
import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.LiveUiRequest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import javax.crypto.KeyGenerator

/** Synthetic identities only; these tests never touch AndroidKeyStore or real credentials. */
class LiveDetailCacheTest {
    private lateinit var directory: java.nio.file.Path
    private val cookie = "c".repeat(64)
    private val token = "edge-fixture-token-not-real"
    private val backend = Backend("backend-fixture", "fixture", "https://fixture.invalid", token)

    @Before fun setup() { directory = Files.createTempDirectory("pidash-live-cache") }
    @After fun teardown() { directory.toFile().deleteRecursively() }

    @Test fun cacheIdentityIncludesBackendOriginCredentialCookieAndProcessWithoutStoringSecrets() {
        val key = liveDetailCacheKey(backend, cookie, "process-fixture")!!
        fun derived(
            backend: Backend = this.backend,
            cookie: String = this.cookie,
            process: String = "process-fixture",
        ) = liveDetailCacheKey(backend, cookie, process)!!.storageId()

        assertEquals(key.storageId(), derived())
        assertNotEquals(key.storageId(), derived(backend = backend.copy(id = "other-backend")))
        assertNotEquals(key.storageId(), derived(backend = backend.copy(baseUrl = "https://other.invalid")))
        assertNotEquals(key.storageId(), derived(backend = backend.copy(token = "other-edge")))
        assertNotEquals(key.storageId(), derived(cookie = "d".repeat(64)))
        assertNotEquals(key.storageId(), derived(process = "other-process"))
        assertNull(liveDetailCacheKey(backend, null, "process-fixture"))

        val exposed = key.toString() + key.storageId() + key.backendStorageId()
        assertFalse(exposed.contains(cookie))
        assertFalse(exposed.contains(token))
    }

    @Test fun sanitizingDropsExecutableUiAndLeaseStateButKeepsRecentTranscript() {
        val original = detail(
            pending = listOf(LiveUiRequest("request-fixture", "confirm", "Approve?")),
            claim = LiveClaim("claimed", "other-client-lease", 9_999),
            entries = listOf("first", "second"),
        )
        val sanitized = sanitizeLiveDetailForCache(original)
        assertTrue(sanitized.pendingUi.isEmpty())
        assertEquals("unclaimed", sanitized.summary.claim.state)
        assertNull(sanitized.summary.claim.leaseId)
        assertEquals(listOf("first", "second"), sanitized.entries.map { it.text() })
    }

    @Test fun imagePayloadsAreOmittedAndReportedAsPartial() {
        val imageMarker = "SYNTHETIC_IMAGE_PAYLOAD"
        val input = detail().copy(entries = listOf(buildJsonObject {
            put("content", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "hello") })
                add(buildJsonObject { put("type", "image"); put("data", imageMarker) })
            })
        }))
        val prepared = prepareLiveDetailForCache(input)
        val json = com.sam.pidash.data.remote.pidashJson.encodeToString(LiveDetail.serializer(), prepared.detail)
        assertFalse(json.contains(imageMarker))
        assertTrue(json.contains("图片未缓存"))
        assertTrue(prepared.truncated)
    }

    @Test fun truncationKeepsTheNewestEntriesAndReportsItself() {
        val entries = (1..80).map { "body-$it-" + "x".repeat(200) }
        val prepared = prepareLiveDetailForCache(detail(entries = entries), maxBytes = 7000)
        assertTrue(prepared.truncated)
        assertTrue(prepared.detail.entries.isNotEmpty())
        assertTrue(prepared.detail.entries.size < entries.size)
        assertEquals(entries.last(), prepared.detail.entries.last().text())
        val encoded = com.sam.pidash.data.remote.pidashJson
            .encodeToString(LiveDetail.serializer(), prepared.detail).toByteArray().size
        assertTrue(encoded <= 7000)
    }

    @Test fun encryptedStoreRoundTripsButNeverWritesPlaintextOrSecrets() = runBlocking {
        val cache = cache()
        val key = liveDetailCacheKey(backend, cookie, "process-fixture")!!
        val marker = "SYNTHETIC_TRANSCRIPT_BODY_MARKER"
        assertTrue(cache.save(key, detail(entries = listOf(marker)), now = 1_000))

        val loaded = cache.load(key, now = 1_000)
        assertNotNull(loaded)
        assertEquals(marker, loaded!!.detail.entries.single().text())
        assertTrue(retainedFiles().isNotEmpty())
        retainedFiles().forEach { file ->
            assertFalse(file.name.contains(cookie))
            assertFalse(file.name.contains(token))
            val bytes = file.readBytes()
            assertFalse(bytes.toString(Charsets.ISO_8859_1).contains(marker))
            assertFalse(bytes.toString(Charsets.ISO_8859_1).contains(cookie))
            assertFalse(bytes.toString(Charsets.ISO_8859_1).contains(token))
        }
    }

    @Test fun anotherBackendOriginCredentialCookieOrProcessCannotReadTheSnapshot() = runBlocking {
        val cache = cache()
        val key = liveDetailCacheKey(backend, cookie, "process-fixture")!!
        assertTrue(cache.save(key, detail(entries = listOf("private body")), now = 1_000))

        val otherKeys = listOf(
            liveDetailCacheKey(backend.copy(id = "other"), cookie, "process-fixture")!!,
            liveDetailCacheKey(backend.copy(baseUrl = "https://other.invalid"), cookie, "process-fixture")!!,
            liveDetailCacheKey(backend.copy(token = "other-edge"), cookie, "process-fixture")!!,
            liveDetailCacheKey(backend, "d".repeat(64), "process-fixture")!!,
            liveDetailCacheKey(backend, cookie, "other-process")!!,
        )
        otherKeys.forEach { assertNull(cache.load(it, now = 1_000)) }
        assertEquals("private body", cache.load(key, now = 1_000)!!.detail.entries.single().text())
    }

    @Test fun storedSnapshotKeepsTheNewestEntriesWithinItsEntryBudget() = runBlocking {
        val limits = LiveDetailCacheLimits(
            ttlMillis = 100_000,
            maxEntries = 4,
            maxTotalBytes = 64 * 1024,
            maxEntryBytes = 5_000,
        )
        val cache = cache(limits)
        val key = liveDetailCacheKey(backend, cookie, "truncated")!!
        val entries = (1..40).map { "recent-$it-" + "x".repeat(80) }
        assertTrue(cache.save(key, detail(process = "truncated", entries = entries), now = 1_000))

        val loaded = cache.load(key, now = 1_000)!!
        assertTrue(loaded.truncated)
        assertTrue(loaded.detail.entries.size < entries.size)
        assertEquals(entries.last(), loaded.detail.entries.last().text())
        assertTrue(retainedFiles().single().length() <= limits.maxEntryBytes)
    }

    @Test fun expiredOrCorruptFilesAreDeletedWithoutAPlaintextFallback() = runBlocking {
        val limits = LiveDetailCacheLimits(ttlMillis = 500, maxEntries = 2, maxTotalBytes = 64 * 1024, maxEntryBytes = 16 * 1024)
        val cache = cache(limits)
        val key = liveDetailCacheKey(backend, cookie, "expired")!!
        assertTrue(cache.save(key, detail(process = "expired", entries = listOf("old body")), now = 1_000))
        val expiredFile = retainedFiles().single()
        assertNull(cache.load(key, now = 1_501))
        assertFalse(expiredFile.exists())

        val corruptKey = liveDetailCacheKey(backend, cookie, "corrupt")!!
        assertTrue(cache.save(corruptKey, detail(process = "corrupt", entries = listOf("secret body")), now = 2_000))
        val corruptFile = retainedFiles().single()
        corruptFile.writeBytes(ByteArray(40) { 7 })
        assertNull(cache.load(corruptKey, now = 2_000))
        assertFalse(corruptFile.exists())
    }

    @Test fun entryCountAndTotalBytesAreBoundedWithOldestFilesRemovedFirst() = runBlocking {
        val limits = LiveDetailCacheLimits(
            ttlMillis = 100_000,
            maxEntries = 2,
            maxTotalBytes = 3_500,
            maxEntryBytes = 6_000,
        )
        val cache = cache(limits)
        (1..5).forEach { index ->
            val key = liveDetailCacheKey(backend, cookie, "process-$index")!!
            val body = "entry-$index-" + "x".repeat(700)
            assertTrue(cache.save(key, detail(process = "process-$index", entries = listOf(body)), now = index * 1_000L))
        }
        val files = retainedFiles()
        assertTrue("expected at most 2 files, got ${files.size}", files.size <= 2)
        assertTrue("cache exceeded byte budget", files.sumOf { it.length() } <= limits.maxTotalBytes)
        assertNull(cache.load(liveDetailCacheKey(backend, cookie, "process-1")!!, now = 5_000))
        assertNotNull(cache.load(liveDetailCacheKey(backend, cookie, "process-5")!!, now = 5_000))
    }

    @Test fun clearingABackendMakesEverySnapshotUnreadable() = runBlocking {
        val cache = cache()
        val first = liveDetailCacheKey(backend, cookie, "one")!!
        val second = liveDetailCacheKey(backend, cookie, "two")!!
        assertTrue(cache.save(first, detail(process = "one"), now = 1_000))
        assertTrue(cache.save(second, detail(process = "two"), now = 1_000))
        cache.clearBackend(backend.id)
        assertNull(cache.load(first, now = 1_000))
        assertNull(cache.load(second, now = 1_000))
        assertTrue(retainedFiles().isEmpty())
    }

    private fun cache(limits: LiveDetailCacheLimits = LiveDetailCacheLimits()) =
        EncryptedLiveDetailCache(directory.toFile(), AesGcmLiveDetailCipher { aesKey }, limits)

    private fun retainedFiles(): List<java.io.File> =
        directory.toFile().walkTopDown().filter { it.isFile }.toList()

    private fun detail(
        process: String = "process-fixture",
        pending: List<LiveUiRequest> = emptyList(),
        claim: LiveClaim = LiveClaim(),
        entries: List<String> = emptyList(),
    ) = LiveDetail(
        summary = LiveSummary(
            processInstanceId = process,
            sessionId = "session-fixture",
            cwd = "/allowed/project",
            claim = claim,
        ),
        entries = entries.map { body -> buildJsonObject { put("text", JsonPrimitive(body)) } },
        pendingUi = pending,
    )

    private fun kotlinx.serialization.json.JsonElement.text(): String =
        (this as kotlinx.serialization.json.JsonObject)["text"]!!.toString().trim('"')

    private companion object {
        val aesKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    }
}
