package com.sam.pidash.data.repo

import com.sam.pidash.data.local.LiveCookieStore
import com.sam.pidash.data.local.LiveCachedDetail
import com.sam.pidash.data.local.LiveDetailCache
import com.sam.pidash.data.local.LiveDetailCacheKey
import com.sam.pidash.data.local.LiveDetailCacheSource
import com.sam.pidash.data.local.NoLiveDetailCache
import com.sam.pidash.data.local.liveDetailCacheKey
import com.sam.pidash.data.remote.*
import com.sam.pidash.domain.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException

private const val CACHE_WRITE_DEBOUNCE_MILLIS = 2500L
private const val MODEL_OPTIONS_TTL_NANOS = 60_000_000_000L

private data class CachedModelOptions(
    val identity: LiveDetailCacheKey,
    val fetchedAtNanos: Long,
    val options: List<LiveModelOption>,
)

/** Live Pi only. Opening/listing never claims; mutations are explicit and never retried. */
class LivePiRepository(
    private val backends: StateFlow<List<Backend>>,
    private val scope: CoroutineScope,
    private val cookies: LiveCookieStore,
    private val detailCache: LiveDetailCache = NoLiveDetailCache,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()
    private val detailStateLock = Any()
    private val clients = mutableMapOf<String, LiveSessionClient>()
    private val modelOptions = mutableMapOf<SessionKey, CachedModelOptions>()
    private val jobs = mutableMapOf<String, Job>()
    private val cacheWrites = mutableMapOf<SessionKey, Job>()
    private val mutationLocks = mutableMapOf<SessionKey, Mutex>()
    private val cacheWriteLocks = mutableMapOf<SessionKey, Mutex>()
    private val starting = mutableSetOf<String>()
    private val organizationFetchedAt = mutableMapOf<String, Long>()
    private val _organization = MutableStateFlow<Map<String, LiveOrganization>>(emptyMap())
    val organization: StateFlow<Map<String, LiveOrganization>> = _organization
    @Volatile private var foreground = false
    @Volatile private var focused: SessionKey? = null
    private val rows = MutableStateFlow<Map<String, List<LiveSummary>>>(emptyMap())
    private val metadata = MutableStateFlow<Map<String, Map<String, LiveMeta>>>(emptyMap())
    private val _states = MutableStateFlow<Map<String, LiveBackendState>>(emptyMap())
    private val _details = MutableStateFlow<Map<SessionKey, LiveDetail>>(emptyMap())
    private val _cacheSources = MutableStateFlow<Map<SessionKey, LiveDetailCacheSource>>(emptyMap())
    private val _leases = MutableStateFlow<Map<SessionKey, LiveLease>>(emptyMap())
    private val _errors = MutableStateFlow<Map<SessionKey, String>>(emptyMap())
    val backendStates: StateFlow<Map<String, LiveBackendState>> = _states
    val details: StateFlow<Map<SessionKey, LiveDetail>> = _details
    /**
     * Keys present here show an offline snapshot loaded from disk, not the server's
     * latest detail. Such a snapshot is display-only: it grants no lease and every
     * mutation still revalidates with the server.
     */
    val cachedSnapshots: StateFlow<Map<SessionKey, LiveDetailCacheSource>> = _cacheSources
    val leases: StateFlow<Map<SessionKey, LiveLease>> = _leases
    val errors: StateFlow<Map<SessionKey, String>> = _errors
    val sessions: StateFlow<List<AggregatedLiveSession>> = combine(backends, rows, metadata) { servers, lists, meta ->
        servers.flatMap { b -> lists[b.id].orEmpty().map {
            AggregatedLiveSession(SessionKey(b.id, it.processInstanceId), b.name, it, meta[b.id]?.get(it.sessionId) ?: LiveMeta())
        } }.sortedWith(compareByDescending<AggregatedLiveSession> { it.meta.pinned }.thenByDescending { it.summary.lastActivityAt })
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    init {
        scope.launch { backends.collect { sync(it) } }
        scope.launch {
            while (isActive) {
                delay(10_000)
                if (!foreground) continue
                _leases.value.toMap().forEach { (key, lease) ->
                    withSessionLock(key) {
                        if (foreground && _leases.value[key]?.leaseId == lease.leaseId) {
                            result(key) {
                                val renewed = client(key.backendId).renew(key.slotKey, lease.leaseId)
                                _leases.update { current ->
                                    if (current[key]?.leaseId == lease.leaseId) current + (key to renewed) else current
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun client(id: String): LiveSessionClient = synchronized(lock) { clients[id] }
        ?: throw IOException("服务器未配置或地址无效")
    private fun isCurrentClient(id: String, api: LiveSessionClient): Boolean = synchronized(lock) { clients[id] === api }
    private fun sync(list: List<Backend>) {
        synchronized(lock) {
            clients.keys.toList().forEach { id ->
                val previous = clients[id] ?: return@forEach
                val next = list.find { it.id == id }
                if (next == previous.backend) return@forEach
                jobs.remove(id)?.cancel()
                previous.close()
                clients.remove(id)
                if (next == null || next.baseUrl != previous.backend.baseUrl || next.token != previous.backend.token) {
                    runCatching { cookies.save(previous.backend, null) }
                }
                clearBackend(id)
            }
            list.forEach { backend ->
                if (clients.containsKey(backend.id)) return@forEach
                try {
                    clients[backend.id] = LiveSessionClient(backend, cookies)
                    if (foreground) startLoop(backend.id)
                } catch (error: Exception) {
                    _states.update { it + (backend.id to LiveBackendState(message = error.message ?: "服务器地址无效")) }
                }
            }
        }
    }
    private fun clearBackend(id: String) {
        rows.update { it - id }; metadata.update { it - id }
        _organization.update { it - id }; organizationFetchedAt.remove(id)
        synchronized(detailStateLock) {
            _details.update { it.filterKeys { key -> key.backendId != id } }
            _cacheSources.update { it.filterKeys { key -> key.backendId != id } }
        }
        _leases.update { it.filterKeys { key -> key.backendId != id } }
        _errors.update { it.filterKeys { key -> key.backendId != id } }
        _states.update { it - id }
        mutationLocks.keys.removeAll { it.backendId == id }
        clearBackendCache(id)
    }

    private fun clearBackendCache(id: String) {
        synchronized(lock) {
            modelOptions.keys.removeAll { it.backendId == id }
            cacheWrites.keys.filter { it.backendId == id }.toList().forEach { cacheWrites.remove(it)?.cancel() }
        }
        synchronized(detailStateLock) {
            val cachedKeys = _cacheSources.value.keys.filter { it.backendId == id }.toSet()
            _details.update { it - cachedKeys }
            _cacheSources.update { it.filterKeys { key -> key.backendId != id } }
        }
        scope.launch { runCatching { detailCache.clearBackend(id) } }
    }

    private fun cacheKeyFor(key: SessionKey): LiveDetailCacheKey? {
        val backend = backends.value.firstOrNull { it.id == key.backendId } ?: return null
        val cookie = runCatching { cookies.load(backend) }.getOrNull() ?: return null
        return runCatching { liveDetailCacheKey(backend, cookie, key.slotKey) }.getOrNull()
    }

    /**
     * Disk is read asynchronously, but only if the server has not already supplied
     * a detail for this focus. `cachedSnapshots` stays populated until a server
     * snapshot replaces it, so callers can never mistake it for the latest detail.
     */
    private fun loadCachedDetail(key: SessionKey) {
        scope.launch {
            val cacheKey = cacheKeyFor(key) ?: return@launch
            val cached = runCatching { detailCache.load(cacheKey, clock()) }.getOrNull() ?: return@launch
            if (focused != key) return@launch
            if (!cachedSnapshotStillMatches(key, cached)) {
                runCatching { detailCache.remove(cacheKey) }
                return@launch
            }
            synchronized(lock) {
                // The cookie or server configuration may have changed while disk I/O was pending.
                if (cacheKeyFor(key) != cacheKey) return@synchronized
                synchronized(detailStateLock) {
                    if (focused == key && !_details.value.containsKey(key)) {
                        // Publish the stale marker before the detail so observers never see it as live.
                        _cacheSources.value = _cacheSources.value + (key to LiveDetailCacheSource(
                            savedAt = cached.savedAt,
                            expiresAt = cached.expiresAt,
                            truncated = cached.truncated,
                        ))
                        _details.value = _details.value + (key to cached.detail)
                    }
                }
            }
        }
    }

    private fun cachedSnapshotStillMatches(key: SessionKey, cached: LiveCachedDetail): Boolean {
        val detail = cached.detail
        if (detail.summary.processInstanceId != key.slotKey) return false
        if (detail.pendingUi.isNotEmpty()) return false
        if (detail.summary.claim.state != "unclaimed" || detail.summary.claim.leaseId != null) return false
        val listed = rows.value[key.backendId]
        // A list that has loaded and no longer contains this process means it was closed/deleted.
        if (listed != null) {
            val current = listed.firstOrNull { it.processInstanceId == key.slotKey } ?: return false
            if (current.sessionId != detail.summary.sessionId) return false
        }
        return true
    }

    /** Debounced so a burst of live deltas produces at most one encrypted file write. */
    private fun scheduleCacheWrite(key: SessionKey, detail: LiveDetail, delayMillis: Long = CACHE_WRITE_DEBOUNCE_MILLIS) {
        if (detailCache === NoLiveDetailCache) return
        synchronized(lock) {
            cacheWrites.remove(key)?.cancel()
            val writeLock = cacheWriteLocks.getOrPut(key) { Mutex() }
            cacheWrites[key] = scope.launch {
                if (delayMillis > 0) delay(delayMillis)
                writeLock.withLock {
                    ensureActive()
                    saveDetailToCache(key, detail)
                }
            }
        }
    }

    private suspend fun saveDetailToCache(key: SessionKey, detail: LiveDetail) {
        val listed = rows.value[key.backendId]
        if (listed != null && listed.none { it.processInstanceId == key.slotKey }) return
        if (_cacheSources.value.containsKey(key)) return // do not extend a disk snapshot's TTL without the server
        val cacheKey = cacheKeyFor(key) ?: return
        try {
            detailCache.save(cacheKey, detail, clock())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Caching is optional; never interrupt a live session on disk failure.
        } finally {
            // Logout or account changes may have raced an in-flight encrypted write.
            withContext(NonCancellable) {
                if (cacheKeyFor(key) != cacheKey) runCatching { detailCache.remove(cacheKey) }
            }
        }
    }

    private fun flushCachedDetail(key: SessionKey) {
        val detail = synchronized(detailStateLock) {
            if (_cacheSources.value.containsKey(key)) null else _details.value[key]
        } ?: return
        scheduleCacheWrite(key, detail, delayMillis = 0)
    }

    private fun removeCachedSession(key: SessionKey) {
        synchronized(lock) { cacheWrites.remove(key)?.cancel() }
        synchronized(detailStateLock) {
            _details.value = _details.value - key
            _cacheSources.value = _cacheSources.value - key
        }
        scope.launch { cacheKeyFor(key)?.let { runCatching { detailCache.remove(it) } } }
    }

    fun close() {
        foreground = false
        synchronized(lock) {
            jobs.values.forEach { it.cancel() }; jobs.clear()
            cacheWrites.values.forEach { it.cancel() }; cacheWrites.clear()
            clients.values.forEach { it.close() }; clients.clear()
            _leases.value = emptyMap()
        }
    }

    fun setForeground(value: Boolean) {
        foreground = value
        synchronized(lock) {
            if (value) clients.keys.forEach(::startLoop)
            else {
                jobs.values.forEach { it.cancel() }; jobs.clear()
                releaseOwned()
                _states.update { states -> states.mapValues { (_, old) -> old.copy(connected = false) } }
            }
        }
    }
    private fun startLoop(id: String) {
        if (jobs[id]?.isActive == true) return
        jobs[id] = scope.launch {
            var backoff = 1000L
            while (isActive && foreground) {
                val api = client(id)
                if (!api.authorized) {
                    rows.update { it - id }
                    _states.update { it + (id to LiveBackendState(needsToken = true, message = "需要输入这台机器的访问令牌")) }
                    delay(1500)
                    continue
                }
                try {
                    refreshBackend(id)
                    socketSession(id, api)
                    backoff = 1000
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { backendFailure(id, error) }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(30_000)
            }
        }
    }
    private suspend fun socketSession(id: String, api: LiveSessionClient) = coroutineScope {
        val closed = CompletableDeferred<Unit>()
        val queue = Channel<JsonObject>(256)
        val seenSnapshots = mutableSetOf<String>()
        val consumer = launch {
            for (frame in queue) {
                handleFrame(id, frame, seenSnapshots)
            }
        }
        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.length > 16 * 1024 * 1024) { webSocket.cancel(); return }
                val frame = runCatching { pidashJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
                if (!queue.trySend(frame).isSuccess) webSocket.cancel() // reconnect + authoritative snapshots, never silently drop deltas
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                closed.completeExceptionally(IOException("Live 实时连接断开；正在重新连接"))
            }
        }
        val socket = api.openSocket(listener)
        val reconcile = launch {
            while (isActive) {
                delay(5000)
                try {
                    refreshBackend(id)
                    focused?.takeIf { it.backendId == id }?.let { refresh(it) }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { backendFailure(id, error) }
            }
        }
        try { closed.await() }
        finally { socket.cancel(); queue.close(); consumer.cancel(); reconcile.cancel() }
    }
    private suspend fun handleFrame(id: String, frame: JsonObject, seen: MutableSet<String>) {
        val data = frame["data"] as? JsonObject ?: return
        when (frame["type"]?.jsonPrimitive?.contentOrNull) {
            "live_session_attached" -> {
                if (data["sessions"] is JsonArray) rows.update { it + (id to pidashJson.decodeFromJsonElement(ListSerializer(LiveSummary.serializer()), data.getValue("sessions"))) }
                else {
                    val detail = pidashJson.decodeFromJsonElement(LiveDetail.serializer(), data)
                    acceptDetail(id, detail, seen.add(detail.summary.processInstanceId))
                }
            }
            "live_session_snapshot" -> {
                val detail = pidashJson.decodeFromJsonElement(LiveDetail.serializer(), data)
                acceptDetail(id, detail, seen.add(detail.summary.processInstanceId))
            }
            "live_session_event" -> {
                val process = data["processInstanceId"]?.jsonPrimitive?.contentOrNull ?: return
                val key = SessionKey(id, process)
                val old = _details.value[key]
                if (old != null && focused == key) {
                    // A cached revision is display-only and cannot be a base for live deltas.
                    if (_cacheSources.value.containsKey(key)) refresh(key)
                    else {
                        val next = reduceLiveEvent(old, data)
                        if (next == null) refresh(key) else acceptDetail(id, next)
                    }
                }
            }
            "live_session_claim_changed", "live_session_reconnecting" -> {
                val summary = pidashJson.decodeFromJsonElement(LiveSummary.serializer(), data)
                updateSummary(id, summary)
            }
            "live_session_goal_changed" -> {
                val process = data["processInstanceId"]?.jsonPrimitive?.contentOrNull ?: return
                val key = SessionKey(id, process)
                if (!_cacheSources.value.containsKey(key)) {
                    _details.update { map -> map[key]?.let { map + (key to it.copy(goal = data["anchor"])) } ?: map }
                }
            }
            "live_session_detached" -> {
                val process = (data["summary"] as? JsonObject)?.get("processInstanceId")?.jsonPrimitive?.contentOrNull ?: return
                rows.update { it + (id to it[id].orEmpty().filterNot { s -> s.processInstanceId == process }) }
                val key = SessionKey(id, process)
                _leases.update { it - key }
                _errors.update { it + (key to "会话已离线或关闭") }
                removeCachedSession(key)
            }
        }
    }
    private fun updateSummary(id: String, summary: LiveSummary) {
        val key = SessionKey(id, summary.processInstanceId)
        val previous = _details.value[key]?.summary
        if (previous != null && previous.sessionId != summary.sessionId) _leases.update { it - key }
        _leases.value[key]?.let { lease ->
            if (summary.claim.state != "claimed" || summary.claim.leaseId != lease.leaseId) _leases.update { it - key }
        }
        rows.update { map -> map + (id to (map[id].orEmpty().filterNot { it.processInstanceId == summary.processInstanceId } + summary)) }
    }
    private fun acceptDetail(id: String, detail: LiveDetail, reset: Boolean = false) {
        val key = SessionKey(id, detail.summary.processInstanceId)
        val old = _details.value[key]
        if (!reset && !_cacheSources.value.containsKey(key) && old?.summary?.sessionId == detail.summary.sessionId &&
            detail.summary.revision <= old.summary.revision && detail.summary.eventSequence < old.summary.eventSequence) return
        updateSummary(id, detail.summary)
        synchronized(detailStateLock) {
            if (focused == key) {
                _details.value = _details.value + (key to detail)
                // From now on this is an authoritative server snapshot, not a disk display.
                _cacheSources.value = _cacheSources.value - key
            }
        }
        if (focused == key) scheduleCacheWrite(key, detail)
    }
    private suspend fun refreshBackend(id: String, forceOrganization: Boolean = false) {
        val api = client(id)
        val list = api.list()
        if (!isCurrentClient(id, api)) return
        val previous = rows.value[id].orEmpty()
        rows.update { it + (id to list) }
        previous.filter { old -> list.none { it.processInstanceId == old.processInstanceId } }
            .forEach { removed -> removeCachedSession(SessionKey(id, removed.processInstanceId)) }
        // Also invalidate cached snapshots that were shown while the list was unavailable
        // and now no longer match the server's process/session identity.
        val cachedKeys = synchronized(detailStateLock) { _cacheSources.value.keys.toList() }
        cachedKeys.filter { key -> key.backendId == id }.filter { key ->
            val current = list.firstOrNull { it.processInstanceId == key.slotKey }
            val cachedSession = _details.value[key]?.summary?.sessionId
            current == null || (cachedSession != null && current.sessionId != cachedSession)
        }.forEach(::removeCachedSession)
        _states.update { it + (id to LiveBackendState(connected = true)) }
        _leases.value.filterKeys { it.backendId == id }.forEach { (key, lease) ->
            val live = list.find { it.processInstanceId == key.slotKey }
            if (live == null || live.claim.state != "claimed" || live.claim.leaseId != lease.leaseId) _leases.update { it - key }
        }
        val meta = api.meta()
        if (!isCurrentClient(id, api)) return
        metadata.update { it + (id to meta) }
        refreshOrganization(id, forceOrganization)
    }
    private suspend fun refreshOrganization(id: String, force: Boolean) {
        val now = System.nanoTime()
        val fresh = synchronized(lock) { organizationFetchedAt[id]?.let { now - it < 30_000_000_000L } == true }
        if (fresh && !force) return
        val api = client(id)
        synchronized(lock) {
            if (clients[id] !== api) return
            organizationFetchedAt[id] = now // Rate-limit failed reads too; an explicit refresh bypasses this cache.
        }
        try {
            val loaded = api.organization()
            if (!isCurrentClient(id, api)) return
            _organization.update { it + (id to loaded) }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (!isCurrentClient(id, api)) return
            if (error is LiveApiException && error.status == 401) throw error
            _organization.update { it + (id to (it[id] ?: LiveOrganization()).copy(error = error.message ?: "分组加载失败")) }
        }
    }
    private suspend fun reconcile(id: String) {
        try { refreshBackend(id) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { backendFailure(id, error) }
    }
    private fun backendFailure(id: String, error: Exception) {
        val authorized = runCatching { client(id).authorized }.getOrDefault(false)
        _states.update { it + (id to LiveBackendState(needsToken = !authorized, message = error.message ?: "Live 连接失败")) }
        if (error is LiveApiException && error.status == 401) {
            _organization.update { it - id }
            synchronized(lock) { organizationFetchedAt.remove(id) }
            rows.update { it - id }
            synchronized(detailStateLock) {
                _details.update { it.filterKeys { key -> key.backendId != id } }
                _cacheSources.update { it.filterKeys { key -> key.backendId != id } }
            }
            _leases.update { it.filterKeys { key -> key.backendId != id } }
            clearBackendCache(id)
        }
    }

    fun focus(key: SessionKey) {
        focused = key
        // Keep only the selected transcript; other sessions' text need not stay in RAM.
        synchronized(detailStateLock) {
            _details.value = _details.value.filterKeys { selected -> selected == key }
            _cacheSources.value = _cacheSources.value.filterKeys { selected -> selected == key }
        }
        loadCachedDetail(key)
        if (foreground) scope.launch { refresh(key) }
    }
    fun unfocus(key: SessionKey) {
        if (focused == key) focused = null
        flushCachedDetail(key)
        scope.launch { release(key) }
    }
    private fun releaseOwned() {
        val owned = _leases.value
        _leases.value = emptyMap()
        owned.forEach { (key, lease) -> scope.launch {
            runCatching { client(key.backendId).release(key.slotKey, lease.leaseId) }
        } }
    }
    suspend fun refreshAll() = coroutineScope {
        synchronized(lock) { clients.keys.toList() }.map { id -> launch {
            try { if (client(id).authorized) refreshBackend(id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { backendFailure(id, error) }
        } }.joinAll()
    }
    suspend fun refreshMachine(id: String): Result<Unit> = result {
        try { refreshBackend(id, forceOrganization = true) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { backendFailure(id, error); throw error }
    }
    /** Monthly usage for the machine this session runs on (the ledger is per dashboard). */
    suspend fun usage(backendId: String, month: String? = null): Result<LiveUsageReport> {
        val target = client(backendId) ?: return Result.failure(IOException("机器未配置"))
        return runCatching { target.usage(month) }
    }

    /** Fork family for one session; the file path comes from the session summary. */
    suspend fun sessionTree(key: SessionKey): Result<LiveSessionTree> {
        val file = details.value[key]?.summary?.sessionFile
            ?: sessions.value.firstOrNull { it.key == key }?.summary?.sessionFile
            ?: return Result.failure(IOException("这个会话没有可读取的会话文件"))
        return client(key.backendId)?.sessionTree(file)?.let { Result.success(it) }
            ?: Result.failure(IOException("机器未配置"))
    }

    suspend fun createGroup(id: String, name: String): Result<Unit> = mutation {
        require(name.isNotBlank() && name.length <= 120) { "分组名需为 1–120 个字符" }
        val api = client(id)
        val groups = api.createGroup(name.trim())
        if (!isCurrentClient(id, api)) throw IOException("机器配置已更改，请先核对原机器的操作结果")
        _organization.update { it + (id to (it[id] ?: LiveOrganization()).copy(groups = groups, loaded = true, error = null)) }
    }
    suspend fun moveSession(key: SessionKey, direction: SessionMove): Result<Unit> = mutation(key) {
        val api = client(key.backendId)
        // Refresh immediately before writing the whole order, retaining unknown ids.
        val org = api.organization()
        val list = api.list()
        val meta = api.meta()
        if (!isCurrentClient(key.backendId, api)) throw IOException("机器配置已更改，请刷新")
        val session = list.firstOrNull { it.processInstanceId == key.slotKey } ?: throw IOException("会话已离线，请刷新")
        val aggregates = list.map { AggregatedLiveSession(SessionKey(key.backendId, it.processInstanceId), "", it, meta[it.sessionId] ?: LiveMeta()) }
        val sections = machineSessionSections(key.backendId, aggregates, org)
        val next = moveMachineSession(sections, org.order.order, session.sessionId, direction)
        val saved = api.saveOrder(next)
        if (!isCurrentClient(key.backendId, api)) throw IOException("机器配置已更改，请核对原机器的排序")
        _organization.update { it + (key.backendId to org.copy(order = org.order.copy(order = saved.order))) }
    }
    suspend fun moveGroup(key: SessionKey, groupId: String?): Result<Unit> = mutation(key) {
        val org = _organization.value[key.backendId] ?: throw IOException("请先加载本机分组")
        val summary = rows.value[key.backendId]?.find { it.processInstanceId == key.slotKey } ?: throw IOException("会话已离线，请刷新")
        val previous = org.groups.find { summary.sessionId in it.sessionIds }
        if (groupId == null && previous == null) return@mutation
        if (groupId != null) require(org.groups.any { it.id == groupId }) { "分组不属于当前机器" }
        val api = client(key.backendId)
        val groups = api.moveGroup(key.slotKey, groupId ?: previous!!.id,
            if (groupId == null) summary.sessionId else null)
        if (!isCurrentClient(key.backendId, api)) throw IOException("机器配置已更改，请先核对原机器的操作结果")
        _organization.update { it + (key.backendId to (it[key.backendId] ?: org).copy(groups = groups, loaded = true, error = null)) }
    }
    suspend fun refresh(key: SessionKey): Result<Unit> = result(key) { acceptDetail(key.backendId, client(key.backendId).detail(key.slotKey)) }
    suspend fun connect(id: String, token: String): Result<Unit> = result {
        client(id).authenticate(token)
        // A new cookie identity must never make a prior session's snapshots readable.
        clearBackendCache(id)
        synchronized(lock) { jobs.remove(id)?.cancel(); if (foreground) startLoop(id) }
        reconcile(id)
    }
    suspend fun disconnect(id: String): Result<Unit> = result {
        try { client(id).signOut() }
        finally {
            synchronized(lock) { jobs.remove(id)?.cancel(); clearBackend(id); if (foreground) startLoop(id) }
        }
    }
    /** Read-only preview of a file the transcript already references. */
    suspend fun readFile(id: String, path: String): Result<String> = result { client(id).readTextFile(path) }
    suspend fun candidates(id: String): Result<List<LiveRepoCandidate>> = result { client(id).candidates() }
    suspend fun startOptions(id: String): Result<LiveStartOptions> = result { client(id).startOptions() }
    suspend fun start(id: String, cwd: String, title: String = "", model: String = "", thinkingLevel: String = ""): Result<SessionKey?> {
        if (!synchronized(lock) { starting.add(id) }) return Result.failure(IOException("已有启动请求，先刷新确认结果"))
        return try { mutation {
            val process = client(id).start(cwd, title, model, thinkingLevel)
            reconcile(id)
            process?.let { SessionKey(id, it) }
        } } finally { synchronized(lock) { starting.remove(id) } }
    }
    private suspend fun <T> withSessionLock(key: SessionKey, block: suspend () -> T): T =
        synchronized(lock) { mutationLocks.getOrPut(key) { Mutex() } }.withLock { block() }
    private suspend fun ensureLease(key: SessionKey): LiveLease {
        _leases.value[key]?.let {
            // Validate ownership with the server before every controlled write.
            val renewed = client(key.backendId).renew(key.slotKey, it.leaseId)
            _leases.update { current -> current + (key to renewed) }
            return renewed
        }
        val acquired = client(key.backendId).claim(key.slotKey)
        _leases.update { it + (key to acquired) }
        return acquired
    }
    suspend fun claim(key: SessionKey): Result<Unit> = withSessionLock(key) { mutation(key) { ensureLease(key); Unit } }
    suspend fun release(key: SessionKey): Result<Unit> = withSessionLock(key) { result(key) {
        val lease = _leases.value[key] ?: return@result
        try { client(key.backendId).release(key.slotKey, lease.leaseId) }
        finally { _leases.update { it - key } }
    } }
    private suspend fun controlled(key: SessionKey, command: suspend (LiveLease) -> JsonObject): Result<Unit> = withSessionLock(key) {
        mutation(key) {
            val lease = ensureLease(key)
            client(key.backendId).command(key.slotKey, command(lease))
            refresh(key)
            Unit
        }
    }
    /**
     * Commands the server accepts without a lease — the same whitelist the WebUI
     * uses for plain input, rename, model switch and reload. Two clients (phone,
     * web, TUI) can therefore type into one session; only `abort`/`compact` need
     * exclusive control, because they interrupt or rewrite running work.
     */
    private suspend fun shared(key: SessionKey, command: suspend () -> JsonObject): Result<Unit> = withSessionLock(key) {
        mutation(key) {
            client(key.backendId).command(key.slotKey, command())
            refresh(key)
            Unit
        }
    }
    suspend fun send(key: SessionKey, text: String, deliverAs: String? = null, images: List<LiveImage> = emptyList()): Result<Unit> {
        if (text.isBlank() && images.isEmpty()) return Result.failure(IOException("消息不能为空"))
        if (text.toByteArray().size > 128 * 1024) return Result.failure(IOException("消息超出大小限制"))
        if (deliverAs != null && deliverAs !in setOf("steer", "followUp")) return Result.failure(IOException("无效投递方式"))
        // Same limits as the WebUI: reject locally instead of letting the bridge refuse it.
        ImageAttachments.validate(images)?.let { return Result.failure(IOException(it)) }
        return shared(key) {
            buildJsonObject {
                put("type", "input")
                put("text", text)
                put("channel", "mobile")
                deliverAs?.let { put("deliverAs", it) }
                if (images.isNotEmpty()) put("images", buildJsonArray {
                    images.forEach { image ->
                        add(buildJsonObject {
                            put("type", "image")
                            put("mimeType", image.mimeType)
                            put("data", image.data)
                        })
                    }
                })
            }
        }
    }
    suspend fun abort(key: SessionKey): Result<Unit> = controlled(key) { buildJsonObject { put("type", "abort"); put("leaseId", it.leaseId) } }
    suspend fun rename(key: SessionKey, name: String): Result<Unit> = shared(key) { buildJsonObject { put("type", "set_session_name"); put("name", name) } }
    suspend fun models(key: SessionKey, force: Boolean = false): Result<List<LiveModelOption>> = result(key) {
        val api = client(key.backendId)
        val identity = cacheKeyFor(key)
        val now = System.nanoTime()
        val cached = synchronized(lock) {
            modelOptions[key]?.takeIf {
                !force && identity != null && it.identity == identity && clients[key.backendId] === api &&
                    now - it.fetchedAtNanos in 0 until MODEL_OPTIONS_TTL_NANOS
            }
        }
        if (cached != null) return@result cached.options
        val response = api.command(key.slotKey, buildJsonObject { put("type", "get_models") })
        val options = pidashJson.decodeFromJsonElement(ListSerializer(LiveModelOption.serializer()), response.jsonObject["models"] ?: JsonArray(emptyList()))
        if (identity != null && isCurrentClient(key.backendId, api) && cacheKeyFor(key) == identity) {
            synchronized(lock) { modelOptions[key] = CachedModelOptions(identity, System.nanoTime(), options) }
        }
        options
    }
    suspend fun setModel(key: SessionKey, provider: String, id: String): Result<Unit> = shared(key) {
        buildJsonObject { put("type", "set_model"); put("provider", provider); put("modelId", id) }
    }
    suspend fun setThinking(key: SessionKey, level: String): Result<Unit> {
        if (level !in setOf("off", "minimal", "low", "medium", "high", "xhigh", "max")) return Result.failure(IOException("无效思考级别"))
        return send(key, "/effort $level")
    }
    /**
     * Hand a still-running foreground call to the background.
     *
     * `feature_command` is lease-bound on the server (same rule as the WebUI), so this
     * takes exclusive control instead of silently steering another client's run.
     */
    suspend fun backgroundToolCall(key: SessionKey, toolCallId: String): Result<Unit> {
        if (!toolCallId.matches(Regex("[A-Za-z0-9_.:-]{1,256}"))) return Result.failure(IOException("无效工具调用标识"))
        return controlled(key) {
            buildJsonObject {
                put("type", "feature_command")
                put("leaseId", it.leaseId)
                put("feature", "background-commands")
                put("command", buildJsonObject { put("type", "background"); put("toolCallId", toolCallId) })
            }
        }
    }

    suspend fun compact(key: SessionKey): Result<Unit> = controlled(key) { buildJsonObject { put("type", "compact"); put("leaseId", it.leaseId) } }
    suspend fun reload(key: SessionKey): Result<Unit> = shared(key) { buildJsonObject { put("type", "reload") } }.also {
        if (it.isSuccess) _leases.update { map -> map - key }
    }
    suspend fun patchMeta(key: SessionKey, tags: List<String>? = null, pinned: Boolean? = null, emoji: String? = null, color: String? = null): Result<Unit> = mutation(key) {
        client(key.backendId).patchMeta(key.slotKey, tags, pinned, emoji, color); reconcile(key.backendId)
    }
    suspend fun context(key: SessionKey): Result<JsonElement> = result(key) {
        require(_details.value[key]?.summary?.capabilities?.contains("context_view") == true) { "此会话扩展不支持上下文检查" }
        client(key.backendId).command(key.slotKey, buildJsonObject { put("type", "get_context") })
    }
    suspend fun tree(key: SessionKey): Result<JsonElement> = result(key) {
        val file = _details.value[key]?.summary?.sessionFile ?: throw IOException("会话文件尚不可用")
        client(key.backendId).get("/api/session-tree?file=" + java.net.URLEncoder.encode(file, "UTF-8"))["result"] ?: JsonNull
    }
    suspend fun answer(key: SessionKey, request: LiveUiRequest, value: String? = null, cancelled: Boolean = false): Result<Unit> = mutation(key) {
        require(request.method in setOf("confirm", "select", "input", "editor")) { "尚不支持此确认类型" }
        require(cancelled || request.method != "select" || value in request.options) { "请选择服务器提供的选项" }
        require(cancelled || request.method != "confirm" || value == "true" || value == "false") { "无效确认值" }
        require(value == null || value.toByteArray().size <= 128 * 1024) { "回答超出大小限制" }
        // Like WebUI: an explicit first answer settles this request, without taking a lease.
        client(key.backendId).command(key.slotKey, buildJsonObject {
            put("type", "answer_ui"); put("id", request.id); put("cancelled", cancelled); value?.let { put("value", it) }
        })
        Unit
    }
    suspend fun restart(key: SessionKey): Result<SessionKey?> = withSessionLock(key) { mutation(key) {
        ensureLease(key)
        val response = client(key.backendId).post(client(key.backendId).path(key.slotKey) + "/restart")
        _leases.update { it - key }; reconcile(key.backendId)
        response["result"]?.jsonObject?.get("processInstanceId")?.jsonPrimitive?.contentOrNull?.let { SessionKey(key.backendId, it) }
    } }
    suspend fun fork(key: SessionKey, entryId: String): Result<SessionKey?> = mutation(key) {
        require(entryId.isNotBlank()) { "缺少真实会话条目 ID" }
        val response = client(key.backendId).post(client(key.backendId).path(key.slotKey) + "/fork", buildJsonObject { put("entryId", entryId) })
        reconcile(key.backendId)
        response["result"]?.jsonObject?.get("processInstanceId")?.jsonPrimitive?.contentOrNull?.let { SessionKey(key.backendId, it) }
    }

    private suspend fun <T> result(key: SessionKey? = null, block: suspend () -> T): Result<T> = try {
        val value = block()
        if (key != null) _errors.update { it - key }
        Result.success(value)
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: Exception) {
        if (key != null) {
            _errors.update { it + (key to (error.message ?: "Live 请求失败")) }
            if (error is LiveApiException && error.status in setOf(401, 409, 423)) _leases.update { it - key }
            if (error is LiveApiException && error.status == 401) backendFailure(key.backendId, error)
        }
        Result.failure(error)
    }
    private suspend fun <T> mutation(key: SessionKey? = null, block: suspend () -> T): Result<T> = result(key) {
        try { block() }
        catch (error: IOException) {
            if (error is LiveApiException) throw error
            throw IOException("操作结果未确认，请先刷新会话，不要直接重复提交", error)
        }
    }
}
