package com.sam.pidash.data.repo

import com.sam.pidash.data.local.LiveCookieStore
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

/** Live Pi only. Opening/listing never claims; mutations are explicit and never retried. */
class LivePiRepository(
    private val backends: StateFlow<List<Backend>>,
    private val scope: CoroutineScope,
    private val cookies: LiveCookieStore,
) {
    private val lock = Any()
    private val clients = mutableMapOf<String, LiveSessionClient>()
    private val jobs = mutableMapOf<String, Job>()
    private val mutationLocks = mutableMapOf<SessionKey, Mutex>()
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
    private val _leases = MutableStateFlow<Map<SessionKey, LiveLease>>(emptyMap())
    private val _errors = MutableStateFlow<Map<SessionKey, String>>(emptyMap())
    val backendStates: StateFlow<Map<String, LiveBackendState>> = _states
    val details: StateFlow<Map<SessionKey, LiveDetail>> = _details
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
        _details.update { it.filterKeys { key -> key.backendId != id } }
        _leases.update { it.filterKeys { key -> key.backendId != id } }
        _errors.update { it.filterKeys { key -> key.backendId != id } }
        _states.update { it - id }
        mutationLocks.keys.removeAll { it.backendId == id }
    }

    fun close() {
        foreground = false
        synchronized(lock) {
            jobs.values.forEach { it.cancel() }; jobs.clear()
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
                if (!api.paired) {
                    rows.update { it - id }
                    _states.update { it + (id to LiveBackendState(needsPairing = true, message = "需要在网页生成一次性手机配对码")) }
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
                    val next = reduceLiveEvent(old, data)
                    if (next == null) refresh(key) else acceptDetail(id, next)
                }
            }
            "live_session_claim_changed", "live_session_reconnecting" -> {
                val summary = pidashJson.decodeFromJsonElement(LiveSummary.serializer(), data)
                updateSummary(id, summary)
            }
            "live_session_goal_changed" -> {
                val process = data["processInstanceId"]?.jsonPrimitive?.contentOrNull ?: return
                val key = SessionKey(id, process)
                _details.update { map -> map[key]?.let { map + (key to it.copy(goal = data["anchor"])) } ?: map }
            }
            "live_session_detached" -> {
                val process = (data["summary"] as? JsonObject)?.get("processInstanceId")?.jsonPrimitive?.contentOrNull ?: return
                rows.update { it + (id to it[id].orEmpty().filterNot { s -> s.processInstanceId == process }) }
                val key = SessionKey(id, process)
                _leases.update { it - key }
                _errors.update { it + (key to "会话已离线或关闭") }
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
        if (!reset && old?.summary?.sessionId == detail.summary.sessionId &&
            detail.summary.revision <= old.summary.revision && detail.summary.eventSequence < old.summary.eventSequence) return
        updateSummary(id, detail.summary)
        if (focused == key) _details.update { it + (key to detail) }
    }
    private suspend fun refreshBackend(id: String, forceOrganization: Boolean = false) {
        val api = client(id)
        val list = api.list()
        if (!isCurrentClient(id, api)) return
        rows.update { it + (id to list) }
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
        val paired = runCatching { client(id).paired }.getOrDefault(false)
        _states.update { it + (id to LiveBackendState(needsPairing = !paired, message = error.message ?: "Live 连接失败")) }
        if (error is LiveApiException && error.status == 401) {
            _organization.update { it - id }
            synchronized(lock) { organizationFetchedAt.remove(id) }
            rows.update { it - id }
            _details.update { it.filterKeys { key -> key.backendId != id } }
            _leases.update { it.filterKeys { key -> key.backendId != id } }
        }
    }

    fun focus(key: SessionKey) {
        focused = key
        // Keep only the selected transcript; other sessions' text need not stay in RAM.
        _details.update { it.filterKeys { selected -> selected == key } }
        if (foreground) scope.launch { refresh(key) }
    }
    fun unfocus(key: SessionKey) {
        if (focused == key) focused = null
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
            try { if (client(id).paired) refreshBackend(id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { backendFailure(id, error) }
        } }.joinAll()
    }
    suspend fun refreshMachine(id: String): Result<Unit> = result {
        try { refreshBackend(id, forceOrganization = true) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { backendFailure(id, error); throw error }
    }
    suspend fun createGroup(id: String, name: String): Result<Unit> = mutation {
        require(name.isNotBlank() && name.length <= 120) { "分组名需为 1–120 个字符" }
        val api = client(id)
        val groups = api.createGroup(name.trim())
        if (!isCurrentClient(id, api)) throw IOException("机器配置已更改，请先核对原机器的操作结果")
        _organization.update { it + (id to (it[id] ?: LiveOrganization()).copy(groups = groups, loaded = true, error = null)) }
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
    suspend fun pair(id: String, code: String): Result<Unit> = result {
        client(id).pair(code)
        synchronized(lock) { jobs.remove(id)?.cancel(); if (foreground) startLoop(id) }
        reconcile(id)
    }
    suspend fun unpair(id: String): Result<Unit> = result {
        try { client(id).unpair() }
        finally {
            synchronized(lock) { jobs.remove(id)?.cancel(); clearBackend(id); if (foreground) startLoop(id) }
        }
    }
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
    suspend fun send(key: SessionKey, text: String, deliverAs: String? = null): Result<Unit> {
        if (text.isBlank()) return Result.failure(IOException("消息不能为空"))
        if (text.toByteArray().size > 128 * 1024) return Result.failure(IOException("消息超出大小限制"))
        if (deliverAs != null && deliverAs !in setOf("steer", "followUp")) return Result.failure(IOException("无效投递方式"))
        return controlled(key) {
            buildJsonObject { put("type", "input"); put("text", text); put("channel", "mobile"); deliverAs?.let { put("deliverAs", it) } }
        }
    }
    suspend fun abort(key: SessionKey): Result<Unit> = controlled(key) { buildJsonObject { put("type", "abort"); put("leaseId", it.leaseId) } }
    suspend fun rename(key: SessionKey, name: String): Result<Unit> = controlled(key) { buildJsonObject { put("type", "set_session_name"); put("name", name) } }
    suspend fun models(key: SessionKey): Result<List<LiveModelOption>> = result(key) {
        val response = client(key.backendId).command(key.slotKey, buildJsonObject { put("type", "get_models") })
        pidashJson.decodeFromJsonElement(ListSerializer(LiveModelOption.serializer()), response.jsonObject["models"] ?: JsonArray(emptyList()))
    }
    suspend fun setModel(key: SessionKey, provider: String, id: String): Result<Unit> = controlled(key) {
        buildJsonObject { put("type", "set_model"); put("provider", provider); put("modelId", id) }
    }
    suspend fun setThinking(key: SessionKey, level: String): Result<Unit> {
        if (level !in setOf("off", "minimal", "low", "medium", "high", "xhigh", "max")) return Result.failure(IOException("无效思考级别"))
        return send(key, "/effort $level")
    }
    suspend fun compact(key: SessionKey): Result<Unit> = controlled(key) { buildJsonObject { put("type", "compact"); put("leaseId", it.leaseId) } }
    suspend fun reload(key: SessionKey): Result<Unit> = controlled(key) { buildJsonObject { put("type", "reload") } }.also {
        if (it.isSuccess) _leases.update { map -> map - key }
    }
    suspend fun patchMeta(key: SessionKey, tags: List<String>? = null, pinned: Boolean? = null): Result<Unit> = mutation(key) {
        client(key.backendId).patchMeta(key.slotKey, tags, pinned); reconcile(key.backendId)
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
