package com.sam.pidash.data.remote

import com.sam.pidash.data.local.LiveCookieStore
import com.sam.pidash.data.local.LiveCachedDetail
import com.sam.pidash.data.local.LiveDetailCache
import com.sam.pidash.data.local.LiveDetailCacheKey
import com.sam.pidash.data.local.NoLiveDetailCache
import com.sam.pidash.data.local.liveCookieBinding
import com.sam.pidash.data.repo.LivePiRepository
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** All credentials and traffic here are synthetic, confined to ephemeral loopback listeners. */
private const val TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

class LiveSessionClientTest {
    private lateinit var server: LoopbackHttpServer
    private lateinit var backend: Backend
    private lateinit var client: LiveSessionClient
    private val cookies = MemoryCookies()
    private val calls = CopyOnWriteArrayList<Call>()
    private val repositories = CopyOnWriteArrayList<LivePiRepository>()
    @Volatile private var handler: (FixtureExchange) -> Unit = { reply(it, "{}") }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cookie = "a".repeat(64)
    private val process = "process-fixture"
    private val detail = """{"summary":{"processInstanceId":"process-fixture","sessionId":"session-fixture","cwd":"/allowed/project","status":"idle","claim":{"state":"claimed","leaseId":"other-client-lease"}},"entries":[]}"""

    @Before fun setup() {
        server = LoopbackHttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            calls += Call(exchange.requestMethod, exchange.requestURI.path,
                exchange.requestHeaders.getFirst("Origin"), exchange.requestHeaders.getFirst("Authorization"),
                exchange.requestHeaders.getFirst("Cookie"), exchange.requestBody.bufferedReader().readText())
            handler(exchange)
        }
        server.start()
        backend = Backend("backend-fixture", "test", "http://127.0.0.1:${server.address.port}", "edge-fixture")
        client = LiveSessionClient(backend, cookies)
    }
    @After fun teardown() { scope.cancel(); repositories.forEach { it.close() }; client.close(); server.stop(0) }

    @Test fun tokenSignInUsesOriginAndIndependentCookieWithEdgeAuthorization() = runBlocking {
        handler = {
            when (it.requestURI.path) {
                "/api/live-sessions/auth" -> {
                    it.responseHeaders.add("Set-Cookie", "pi_live_session=$cookie; Path=/api/live-sessions; HttpOnly; SameSite=Strict")
                    reply(it, """{"ok":true,"browserClientId":"native-fixture"}""")
                }
                else -> reply(it, """{"sessions":[]}""")
            }
        }
        client.authenticate(TOKEN)
        assertTrue(client.authorized)
        client.list()
        assertEquals(backend.baseUrl, calls[0].origin)
        assertEquals("Bearer edge-fixture", calls[0].authorization)
        assertNull(calls[0].cookie)
        assertEquals("pi_live_session=$cookie", calls[1].cookie)
        assertTrue(calls.all { it.path.startsWith("/api/live-sessions") })
    }

    @Test fun organizationAndGroupEditsUseExistingProtectedEndpointsWithoutClaiming() = runBlocking {
        cookies.save(backend, cookie)
        handler = { if (it.requestURI.path == "/api/live-session-order") reply(it, """{"order":["session-fixture"],"sectionOrder":["work"]}""")
            else reply(it, """{"groups":[{"id":"work","name":"Work","sessionIds":["session-fixture"],"createdAt":"fixture"}]}""") }
        val org = client.organization()
        assertTrue(org.loaded)
        assertEquals("Work", org.groups.single().name)
        assertEquals(listOf("session-fixture"), org.order.order)
        client.createGroup("Another")
        client.moveGroup(process, "work")
        client.moveGroup(process, "work", "session-fixture")
        assertEquals(listOf("GET", "GET", "POST", "POST", "DELETE"), calls.map { it.method })
        assertTrue(calls.all { it.origin == backend.baseUrl && it.cookie == "pi_live_session=$cookie" && it.authorization == "Bearer edge-fixture" })
        assertTrue(calls.none { it.path.endsWith("/claim") || it.path.endsWith("/commands") || it.path.contains("/chat/") })
        assertTrue(calls[3].body.contains("\"processInstanceId\":\"$process\""))
        assertEquals("/api/live-session-groups/work/members/session-fixture", calls.last().path)
    }

    @Test fun orderAndAppearanceWritesUseProtectedEndpoints() = runBlocking {
        cookies.save(backend, cookie)
        handler = { if (it.requestURI.path == "/api/live-session-order") reply(it, """{"ok":true,"order":["session-fixture"]}""") else reply(it, """{"ok":true}""") }
        assertEquals(listOf("session-fixture"), client.saveOrder(listOf("session-fixture")).order)
        client.patchMeta(process, null, null, "🐱", "#5287be")
        assertEquals(listOf("PUT", "PATCH"), calls.map { it.method })
        assertEquals("/api/live-session-order", calls[0].path)
        assertEquals("""{"order":["session-fixture"]}""", calls[0].body)
        assertTrue(calls[1].body.contains("🐱"))
        assertTrue(calls[1].body.contains("\"color\":\"#5287be\""))
        assertTrue(calls.all { it.cookie == "pi_live_session=$cookie" })
        assertTrue(calls.none { it.path.endsWith("/claim") })
    }

    @Test fun malformedGroupPathsFailBeforeSendingCredentials() = runBlocking {
        cookies.save(backend, cookie)
        assertTrue(runCatching { client.moveGroup(process, "../../auth") }.isFailure)
        assertTrue(runCatching { client.moveGroup(process, "work", "../../auth") }.isFailure)
        assertTrue(calls.isEmpty())
    }

    @Test fun failedGroupCreationIsNeverRetried() = runBlocking {
        cookies.save(backend, cookie)
        handler = { reply(it, "{}", 503) }
        assertTrue(runCatching { client.createGroup("Work") }.isFailure)
        assertEquals(1, calls.size)
    }

    @Test fun liveStartAndOptionsNeverUseOrdinaryChatSlots() = runBlocking {
        cookies.save(backend, cookie)
        handler = { when (it.requestURI.path) {
            "/api/live-sessions/start-options" -> reply(it, """{"roots":["/allowed"]}""")
            "/api/live-sessions/start" -> reply(it, """{"ok":true,"result":{"processInstanceId":"process-fixture"}}""")
            else -> reply(it, "{}", 404)
        } }
        assertEquals(listOf("/allowed"), client.startOptions().roots)
        assertEquals(process, client.start("/allowed/project", "Title", "provider/model", "high"))
        assertTrue(calls.last().body.contains("\"cwd\":\"/allowed/project\""))
        assertTrue(calls.last().body.contains("\"thinkingLevel\":\"high\""))
        assertTrue(calls.none { it.path.contains("/chat/") })
    }

    @Test fun malformedTokenAndRelativePathFailBeforeNetwork() = runBlocking {
        // A 32-char pairing code is no longer a credential; the token is 64 hex chars.
        assertTrue(runCatching { client.authenticate("b".repeat(32)) }.isFailure)
        assertTrue(runCatching { client.authenticate("not-a-token") }.isFailure)
        assertTrue(runCatching { client.start("../outside", "", "", "") }.isFailure)
        assertTrue(calls.isEmpty())
    }

    @Test fun expiredLiveCookieIsClearedButEdgeFailureDoesNotEraseLiveIdentity() = runBlocking {
        cookies.save(backend, cookie)
        handler = { reply(it, """{"error":"edge_unauthorized"}""", 401) }
        assertTrue(runCatching { client.list() }.isFailure)
        assertTrue(client.authorized)
        handler = { reply(it, """{"error":"authentication_required"}""", 401) }
        assertTrue(runCatching { client.list() }.isFailure)
        assertFalse(client.authorized)
    }

    @Test fun redirectsNeverForwardAnyCredentialOrToken() = runBlocking {
        val destination = LoopbackHttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val destinationCalls = java.util.concurrent.atomic.AtomicInteger()
        destination.createContext("/") { destinationCalls.incrementAndGet(); reply(it, "{}") }
        destination.start()
        try {
            cookies.save(backend, cookie)
            handler = {
                it.responseHeaders.add("Location", "http://127.0.0.1:${destination.address.port}/stolen")
                reply(it, "{}", 307)
            }
            assertTrue(runCatching { client.authenticate(TOKEN) }.isFailure)
            assertEquals(0, destinationCalls.get())
            assertEquals(1, calls.size)
        } finally { destination.stop(0) }
    }

    @Test fun failedLogoutStillDeletesLocalCookie() = runBlocking {
        cookies.save(backend, cookie)
        handler = { reply(it, "{}", 500) }
        assertTrue(runCatching { client.signOut() }.isFailure)
        assertFalse(client.authorized)
        assertEquals("DELETE", calls.single().method)
    }

    @Test fun websocketUsesHeadersNotCredentialsInUrl() {
        cookies.save(backend, cookie)
        handler = { reply(it, "{}", 401) }
        val done = CountDownLatch(1)
        val socket = client.openSocket(object : WebSocketListener() {
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { done.countDown() }
        })
        try {
            assertTrue(done.await(10, TimeUnit.SECONDS))
            assertEquals("/api/live-sessions/ws", calls.single().path)
            assertEquals(backend.baseUrl, calls.single().origin)
            assertEquals("pi_live_session=$cookie", calls.single().cookie)
            assertEquals("Bearer edge-fixture", calls.single().authorization)
        } finally { socket.cancel() }
    }

    @Test fun oversizedResponsesAreRejectedBeforeDecode() = runBlocking {
        handler = {
            it.sendResponseHeaders(200, 16L * 1024 * 1024 + 1)
            it.close()
        }
        val error = runCatching { client.list() }.exceptionOrNull()
        assertTrue(error?.message.orEmpty().contains("大小限制"))
    }

    @Test fun liveUrlsRequireHttpsAndNeverAcceptEmbeddedCredentials() {
        listOf("http://192.168.3.46:7777", "http://example.test", "https://user:pass@example.test", "https://example.test?token=x", "https://example.test/#secret").forEach {
            assertTrue(it, runCatching { validateLiveBaseUrl(it) }.isFailure)
        }
        assertEquals("example.test", validateLiveBaseUrl("https://example.test").host)
        assertTrue(runCatching { client.path("a/../../chat/slots") }.isFailure)
        assertTrue(runCatching { edgeAuthorization("x\r\nInjected: y") }.isFailure)
    }

    @Test fun cookieBindingIncludesBackendOriginAndCredentialButNotDisplayName() {
        assertEquals(liveCookieBinding(backend), liveCookieBinding(backend.copy(name = "renamed")))
        assertNotEquals(liveCookieBinding(backend), liveCookieBinding(backend.copy(baseUrl = "https://different.test")))
        assertNotEquals(liveCookieBinding(backend), liveCookieBinding(backend.copy(token = "different-fixture")))
        assertFalse(liveCookieBinding(backend).contains(backend.token))
    }

    private suspend fun repository(cache: LiveDetailCache = NoLiveDetailCache): LivePiRepository {
        cookies.save(backend, cookie)
        handler = { when (it.requestURI.path) {
            "/api/live-sessions/repo-candidates" -> reply(it, """{"repos":[]}""")
            "/api/live-sessions/$process" -> reply(it, detail)
            "/api/live-session-meta" -> reply(it, """{"meta":{}}""")
            else -> reply(it, "{}", 404)
        } }
        val repo = LivePiRepository(MutableStateFlow(listOf(backend)), scope, cookies, cache).also { repositories.add(it) }
        withTimeout(5000) { while (repo.candidates(backend.id).isFailure) delay(20) }
        calls.clear()
        return repo
    }

    @Test fun modelChoicesAreReusedBrieflyButForceRefreshAndAuthChangesBypassCache() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        handler = { reply(it, """{"result":{"models":[{"provider":"fixture","id":"model"}]}}""") }
        calls.clear()
        assertEquals("model", repo.models(key).getOrThrow().single().id)
        assertEquals("model", repo.models(key).getOrThrow().single().id)
        assertEquals(1, calls.size)
        assertTrue(repo.models(key, force = true).isSuccess)
        assertEquals(2, calls.size)
        cookies.save(backend, null)
        // Even if a server fixture accepts the request, an old authenticated cache is not reused.
        repo.models(key)
        assertEquals(3, calls.size)
    }

    @Test fun machineOrganizationFailureDoesNotTurnConnectedLiveRowsIntoAnEmptyList() = runBlocking {
        val repo = repository()
        handler = { when (it.requestURI.path) {
            "/api/live-sessions" -> reply(it, """{"sessions":[{"processInstanceId":"$process","sessionId":"session-fixture","cwd":"/allowed"}]}""")
            "/api/live-session-meta" -> reply(it, """{"meta":{}}""")
            "/api/live-session-groups" -> reply(it, "{}", 500)
            else -> reply(it, "{}", 404)
        } }
        assertTrue(repo.refreshMachine(backend.id).isSuccess)
        withTimeout(5000) { while (repo.sessions.value.isEmpty()) delay(20) }
        assertTrue(repo.backendStates.value[backend.id]!!.connected)
        assertNotNull(repo.organization.value[backend.id]!!.error)
        assertFalse(repo.organization.value[backend.id]!!.loaded)
        assertEquals(process, repo.sessions.value.single().key.slotKey)
        assertTrue(calls.all { it.method == "GET" })
        val groupReads = calls.count { it.path == "/api/live-session-groups" }
        repo.refreshAll()
        assertEquals(groupReads, calls.count { it.path == "/api/live-session-groups" })
    }

    @Test fun malformedGroupWriteAcknowledgementIsUnconfirmedAndNeverRetried() = runBlocking {
        val repo = repository()
        handler = { reply(it, "{}") }
        val result = repo.createGroup(backend.id, "Work")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("未确认"))
        assertEquals(1, calls.size)
    }

    @Test fun groupMovesAreScopedToTheMachineAndExpiredAuthPurgesOrganization() = runBlocking {
        val repo = repository()
        handler = { when (it.requestURI.path) {
            "/api/live-sessions" -> reply(it, """{"sessions":[{"processInstanceId":"$process","sessionId":"session-fixture","cwd":"/allowed"}]}""")
            "/api/live-session-meta" -> reply(it, """{"meta":{}}""")
            "/api/live-session-order" -> reply(it, """{"order":[],"sectionOrder":[]}""")
            else -> reply(it, """{"groups":[{"id":"work","name":"Work","sessionIds":["session-fixture"]}]}""")
        } }
        assertTrue(repo.refreshMachine(backend.id).isSuccess)
        val key = SessionKey(backend.id, process)
        val before = calls.size
        assertTrue(repo.moveGroup(key, "group-from-another-machine").isFailure)
        assertEquals(before, calls.size)
        assertTrue(repo.moveGroup(key, "work").isSuccess)
        assertTrue(calls.none { it.path.endsWith("/claim") || it.path.endsWith("/commands") })
        handler = { reply(it, """{"error":"authentication_required"}""", 401) }
        assertTrue(repo.refreshMachine(backend.id).isFailure)
        assertTrue(repo.organization.value.isEmpty())
        assertTrue(repo.backendStates.value[backend.id]!!.needsToken)
    }

    @Test fun plainInputSucceedsWithoutTakingControlEvenWhenAnotherClientHoldsIt() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        repo.focus(key)
        assertTrue(repo.refresh(key).isSuccess)
        // The fixture session is already claimed by another client.
        assertEquals("other-client-lease", repo.details.value[key]?.summary?.claim?.leaseId)
        handler = {
            if (it.requestURI.path.endsWith("/commands")) reply(it, """{"ok":true,"result":{}}""")
            else reply(it, detail)
        }
        calls.clear()
        // Same rule as the WebUI: typing, renaming and switching model are shared;
        // they neither need nor take exclusive control.
        assertTrue(repo.send(key, "hello from the phone").isSuccess)
        assertTrue(repo.rename(key, "Title").isSuccess)
        val bodies = calls.filter { it.path.endsWith("/commands") }.map { it.body }
        assertEquals(2, bodies.size)
        assertTrue(bodies.first().contains("\"type\":\"input\""))
        assertTrue(bodies.none { it.contains("leaseId") })
        assertTrue(calls.none { it.path.endsWith("/claim") || it.path.endsWith("/renew") })
        assertTrue(repo.leases.value.isEmpty())
    }

    @Test fun abortStillRequiresAnExplicitLease() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        handler = {
            if (it.requestURI.path.endsWith("/commands")) reply(it, """{"ok":true,"result":{}}""")
            else reply(it, detail)
        }
        calls.clear()
        // The fixture never returns a lease for /claim, so an interrupt cannot proceed.
        assertTrue(repo.abort(key).isFailure)
        assertTrue(calls.any { it.path.endsWith("/claim") })
        assertTrue(calls.none { it.path.endsWith("/commands") })
    }

    @Test fun openingIsReadOnlyAndPublicLeaseIdDoesNotEstablishOwnership() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        repo.focus(key)
        assertTrue(repo.refresh(key).isSuccess)
        assertEquals("other-client-lease", repo.details.value[key]?.summary?.claim?.leaseId)
        assertTrue(repo.leases.value.isEmpty())
        assertTrue(calls.all { it.method == "GET" })
        assertTrue(calls.none { it.path.endsWith("/claim") || it.path.endsWith("/commands") })
    }

    @Test fun anotherClientsLeaseBlocksInterruptButNeverBlocksPlainInput() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        // Interrupting running work still needs exclusive control and must never steal it.
        handler = { reply(it, """{"error":"lease_held","message":"owned elsewhere"}""", 423) }
        assertTrue(repo.abort(key).isFailure)
        assertTrue(calls.isNotEmpty() && calls.all { it.path.endsWith("/claim") })
        assertTrue(repo.leases.value.isEmpty())
        // Typing is shared, exactly like the WebUI: no claim, no retry, no lease.
        handler = { reply(it, """{"ok":true,"result":{}}""") }
        calls.clear()
        assertTrue(repo.send(key, "synthetic input").isSuccess)
        assertTrue(calls.none { it.path.endsWith("/claim") || it.path.endsWith("/renew") })
    }

    @Test fun staleLeaseIsRevalidatedBeforeAnInterruptAndNothingIsDispatchedOnFailure() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        handler = { if (it.requestURI.path.endsWith("/claim")) reply(it, """{"ok":true,"result":{"leaseId":"lease-fixture","expiresAt":999999}}""")
            else reply(it, """{"error":"invalid_lease"}""", 423) }
        assertTrue(repo.claim(key).isSuccess)
        assertTrue(repo.abort(key).isFailure)
        assertEquals(listOf("/api/live-sessions/$process/claim", "/api/live-sessions/$process/renew"), calls.map { it.path })
        assertTrue(calls.none { it.path.endsWith("/commands") })
        assertTrue(repo.leases.value.isEmpty())
    }

    @Test fun blankInputDoesNotEvenClaim() = runBlocking {
        val repo = repository()
        assertTrue(repo.send(SessionKey(backend.id, process), "  ").isFailure)
        assertTrue(calls.isEmpty())
    }

    @Test fun backgroundReleasesOnlyLocallyOwnedLease() = runBlocking {
        val repo = repository()
        val key = SessionKey(backend.id, process)
        handler = { if (it.requestURI.path.endsWith("/claim")) reply(it, """{"ok":true,"result":{"leaseId":"lease-fixture"}}""") else reply(it, """{"ok":true}""") }
        assertTrue(repo.claim(key).isSuccess)
        repo.setForeground(false)
        withTimeout(5000) { while (calls.none { it.path.endsWith("/release") }) delay(20) }
        assertTrue(repo.leases.value.isEmpty())
        assertEquals(1, calls.count { it.path.endsWith("/release") })
    }

    @Test fun extensionAnswersAreExplicitWithoutImplicitClaim() = runBlocking {
        val repo = repository()
        handler = { reply(it, """{"ok":true,"result":{}}""") }
        val request = com.sam.pidash.domain.model.LiveUiRequest("request-fixture", "confirm", "Approve?")
        assertTrue(repo.answer(SessionKey(backend.id, process), request, "true").isSuccess)
        assertEquals(1, calls.size)
        assertTrue(calls.single().path.endsWith("/commands"))
        assertTrue(calls.single().body.contains("\"type\":\"answer_ui\""))
        assertTrue(repo.leases.value.isEmpty())
    }

    @Test fun invalidExtensionSelectionDoesNotSendOrClaim() = runBlocking {
        val repo = repository()
        val request = com.sam.pidash.domain.model.LiveUiRequest("request-fixture", "select", options = listOf("safe"))
        assertTrue(repo.answer(SessionKey(backend.id, process), request, "invented-option").isFailure)
        assertTrue(calls.isEmpty())
    }

    @Test fun cacheLoadMarksProvenanceAndServerSnapshotAlwaysWins() = runBlocking {
        val cache = MemoryDetailCache().apply {
            cached = LiveCachedDetail(cachedDetail(revision = 1, entry = "disk-old"), 1_000, 99_999, truncated = true)
        }
        val repo = repository(cache)
        val key = SessionKey(backend.id, process)

        repo.focus(key)
        withTimeout(5000) { while (!repo.cachedSnapshots.value.containsKey(key) || repo.details.value[key] == null) delay(10) }
        assertEquals("disk-old", repo.details.value[key]!!.entries.single().text())
        assertTrue(repo.cachedSnapshots.value.getValue(key).truncated)

        handler = { if (it.requestURI.path == "/api/live-sessions/$process") reply(it, serverDetail(revision = 2, entry = "server-new"))
            else reply(it, "{}", 404) }
        assertTrue(repo.refresh(key).isSuccess)
        assertEquals("server-new", repo.details.value[key]!!.entries.single().text())
        assertFalse(repo.cachedSnapshots.value.containsKey(key))
    }

    @Test fun aLateDiskLoadNeverOverwritesAServerSnapshot() = runBlocking {
        val gate = CountDownLatch(1)
        val cache = MemoryDetailCache().apply {
            loadGate = gate
            cached = LiveCachedDetail(cachedDetail(revision = 1, entry = "disk-old"), 1_000, 99_999, truncated = false)
        }
        val repo = repository(cache)
        val key = SessionKey(backend.id, process)

        repo.focus(key)
        assertTrue(cache.loadStarted.await(5, TimeUnit.SECONDS))
        handler = { if (it.requestURI.path == "/api/live-sessions/$process") reply(it, serverDetail(revision = 3, entry = "server-new"))
            else reply(it, "{}", 404) }
        assertTrue(repo.refresh(key).isSuccess)
        assertEquals("server-new", repo.details.value[key]!!.entries.single().text())

        gate.countDown()
        withTimeout(5000) { while (!cache.loadFinished) delay(10) }
        delay(100)
        assertEquals("server-new", repo.details.value[key]!!.entries.single().text())
        assertFalse(repo.cachedSnapshots.value.containsKey(key))
    }

    @Test fun changedCookieWhileCacheLoadsNeverDisplaysOldContent() = runBlocking {
        val gate = CountDownLatch(1)
        val cache = MemoryDetailCache().apply {
            loadGate = gate
            cached = LiveCachedDetail(cachedDetail(revision = 1, entry = "old-account"), 1_000, 99_999, truncated = false)
        }
        val repo = repository(cache)
        val key = SessionKey(backend.id, process)
        repo.focus(key)
        assertTrue(cache.loadStarted.await(5, TimeUnit.SECONDS))
        cookies.save(backend, null)
        gate.countDown()
        withTimeout(5000) { while (!cache.loadFinished) delay(10) }
        delay(100)
        assertNull(repo.details.value[key])
        assertFalse(repo.cachedSnapshots.value.containsKey(key))
    }

    @Test fun aWriteRacingLogoutIsRemovedAfterItFinishes() = runBlocking {
        val gate = CountDownLatch(1)
        val cache = MemoryDetailCache().apply { saveGate = gate }
        val repo = repository(cache)
        val key = SessionKey(backend.id, process)
        repo.focus(key)
        assertTrue(repo.refresh(key).isSuccess)
        repo.unfocus(key)
        assertTrue(cache.saveStarted.await(5, TimeUnit.SECONDS))
        cookies.save(backend, null)
        gate.countDown()
        withTimeout(5000) { while (cache.removed.none { it.processInstanceId == process }) delay(10) }
        assertTrue(cache.removed.any { it.processInstanceId == process })
    }

    @Test fun anAuthoritativeSnapshotCanReplaceACacheWithHigherOldSequence() = runBlocking {
        val old = cachedDetail(revision = 30, entry = "old-cache")
        val cache = MemoryDetailCache().apply {
            cached = LiveCachedDetail(old.copy(summary = old.summary.copy(eventSequence = 100)), 1_000, 99_999, truncated = false)
        }
        val repo = repository(cache)
        val key = SessionKey(backend.id, process)
        repo.focus(key)
        withTimeout(5000) { while (repo.details.value[key] == null) delay(10) }
        handler = { if (it.requestURI.path == "/api/live-sessions/$process") reply(it, serverDetail(revision = 1, entry = "authoritative")) else reply(it, "{}", 404) }
        assertTrue(repo.refresh(key).isSuccess)
        assertEquals("authoritative", repo.details.value[key]!!.entries.single().text())
        assertFalse(repo.cachedSnapshots.value.containsKey(key))
    }

    @Test fun unauthorizedAndRemovedSessionsClearTheirCachedBodies() = runBlocking {
        val cache = MemoryDetailCache()
        val repo = repository(cache)
        val key = SessionKey(backend.id, process)

        handler = { when (it.requestURI.path) {
            "/api/live-sessions" -> reply(it, """{"sessions":[{"processInstanceId":"$process","sessionId":"session-fixture","cwd":"/allowed"}]}""")
            "/api/live-session-meta" -> reply(it, """{"meta":{}}""")
            else -> reply(it, "{}", 404)
        } }
        assertTrue(repo.refreshMachine(backend.id).isSuccess)
        withTimeout(5000) { while (repo.sessions.value.isEmpty()) delay(10) }

        handler = { when (it.requestURI.path) {
            "/api/live-sessions" -> reply(it, """{"sessions":[]}""")
            "/api/live-session-meta" -> reply(it, """{"meta":{}}""")
            else -> reply(it, "{}", 404)
        } }
        assertTrue(repo.refreshMachine(backend.id).isSuccess)
        withTimeout(5000) { while (cache.removed.none { it.processInstanceId == process }) delay(10) }

        handler = { reply(it, """{"error":"authentication_required"}""", 401) }
        assertTrue(repo.refreshMachine(backend.id).isFailure)
        withTimeout(5000) { while (backend.id !in cache.clearedBackends) delay(10) }
        assertTrue(cache.removed.any { it.processInstanceId == process })
    }

    private data class Call(val method: String, val path: String, val origin: String?, val authorization: String?, val cookie: String?, val body: String)
    private class MemoryCookies : LiveCookieStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun load(backend: Backend): String? = values[liveCookieBinding(backend)]
        override fun save(backend: Backend, cookie: String?) {
            if (cookie == null) values.remove(liveCookieBinding(backend)) else values[liveCookieBinding(backend)] = cookie
        }
    }
    private fun kotlinx.serialization.json.JsonElement.text(): String =
        (this as kotlinx.serialization.json.JsonObject)["text"]!!.toString().trim('"')

    private fun cachedDetail(revision: Long, entry: String): LiveDetail =
        pidashJson.decodeFromJsonElement(LiveDetail.serializer(), pidashJson.parseToJsonElement(serverDetail(revision, entry)))

    private fun serverDetail(revision: Long, entry: String): String =
        """{"summary":{"processInstanceId":"$process","sessionId":"session-fixture","cwd":"/allowed/project","revision":$revision},"entries":[{"text":"$entry"}]}"""

    private class MemoryDetailCache : LiveDetailCache {
        @Volatile var cached: LiveCachedDetail? = null
        @Volatile var loadGate: CountDownLatch? = null
        @Volatile var saveGate: CountDownLatch? = null
        @Volatile var loadFinished = false
        val loadStarted = CountDownLatch(1)
        val saveStarted = CountDownLatch(1)
        val removed = CopyOnWriteArrayList<LiveDetailCacheKey>()
        val clearedBackends = CopyOnWriteArrayList<String>()

        override suspend fun load(key: LiveDetailCacheKey, now: Long): LiveCachedDetail? {
            loadStarted.countDown()
            return try {
                loadGate?.await(5, TimeUnit.SECONDS)
                cached
            } finally {
                loadFinished = true
            }
        }

        override suspend fun save(key: LiveDetailCacheKey, detail: LiveDetail, now: Long): Boolean {
            saveStarted.countDown()
            saveGate?.await(5, TimeUnit.SECONDS)
            return true
        }
        override suspend fun remove(key: LiveDetailCacheKey) { removed += key }
        override suspend fun clearBackend(backendId: String) { clearedBackends += backendId }
    }

    private fun reply(exchange: FixtureExchange, body: String, status: Int = 200) {
        val bytes = body.toByteArray()
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}
