package com.sam.pidash.data.repo

import com.sam.pidash.data.local.BackendStore
import com.sam.pidash.core.nowMillis
import com.sam.pidash.data.remote.DashboardClient
import com.sam.pidash.data.remote.WsFrame
import com.sam.pidash.domain.model.AggregatedSlot
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ChatMessage
import com.sam.pidash.domain.model.ChatSlot
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.domain.model.MessageRole
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Single source of truth for the whole app.
 *
 * Keeps one [DashboardClient] per backend (independent auth / socket / reconnect),
 * merges their slot lists into [aggregatedSlots], and holds per-session message
 * state so the UI can read plain [StateFlow]s.
 */
class PiDashRepository(
    private val store: BackendStore,
    private val scope: CoroutineScope,
) {
    private val clients = mutableMapOf<String, DashboardClient>()
    private val clientJobs = mutableMapOf<String, Job>()

    private val _backends = MutableStateFlow<List<Backend>>(emptyList())
    val backends: StateFlow<List<Backend>> = _backends

    private val _slotsByBackend = MutableStateFlow<Map<String, List<ChatSlot>>>(emptyMap())
    private val _connection = MutableStateFlow<Map<String, ConnectionState>>(emptyMap())
    private val _messages = MutableStateFlow<Map<SessionKey, List<ChatMessage>>>(emptyMap())
    private val _streaming = MutableStateFlow<Map<SessionKey, String>>(emptyMap())
    private val _running = MutableStateFlow<Set<SessionKey>>(emptySet())
    private val _lastError = MutableStateFlow<Map<SessionKey, String>>(emptyMap())

    val connection: StateFlow<Map<String, ConnectionState>> = _connection
    val messages: StateFlow<Map<SessionKey, List<ChatMessage>>> = _messages
    val streaming: StateFlow<Map<SessionKey, String>> = _streaming
    val running: StateFlow<Set<SessionKey>> = _running
    val lastError: StateFlow<Map<SessionKey, String>> = _lastError

    /** All slots from all backends, newest activity first, tagged with backend name. */
    val aggregatedSlots: StateFlow<List<AggregatedSlot>> =
        combine(_backends, _slotsByBackend) { backends, slots ->
            backends.flatMap { b ->
                slots[b.id].orEmpty().map { AggregatedSlot(SessionKey(b.id, it.key), b.name, it) }
            }.sortedByDescending { it.slot.updatedAt }
        }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    init {
        scope.launch {
            store.backends.collect { list ->
                _backends.value = list
                syncClients(list)
            }
        }
    }

    // -- client lifecycle --------------------------------------------------

    private fun syncClients(list: List<Backend>) {
        // Drop clients whose backend was removed — or whose config (url/token/name) changed.
        clients.keys.toList().forEach { id ->
            val current = clients[id] ?: return@forEach
            val target = list.firstOrNull { it.id == id }
            if (target != null && target == current.backend) return@forEach
            clientJobs.remove(id)?.cancel()
            current.close()
            clients.remove(id)
            _slotsByBackend.update { it - id }
            _connection.update { it - id }
        }

        // Start a client for every new backend.
        list.forEach { b ->
            if (clients.containsKey(b.id)) return@forEach
            val client = DashboardClient(b, scope)
            clients[b.id] = client
            clientJobs[b.id] = scope.launch {
                launch {
                    client.connection.collect { st -> _connection.update { it + (b.id to st) } }
                }
                client.frames.collect { handleFrame(b, it) }
            }
            client.start()
        }
    }

    // -- frame handling ----------------------------------------------------

    private suspend fun handleFrame(backend: Backend, frame: WsFrame) {
        val bid = backend.id
        when (frame) {
            is WsFrame.Slots -> {
                val models = frame.slots.map { it.toModel() }
                _slotsByBackend.update { it + (bid to models) }
                val serverRunning = models.filter { it.running }.map { SessionKey(bid, it.key) }.toSet()
                _running.update { current ->
                    val next = current.filterNot { it.backendId == bid }.toMutableSet()
                    next.addAll(serverRunning)
                    next
                }
                // The socket may have missed `chat_done` (connection dropped, app
                // backgrounded, server restarted mid-turn). A slot the server reports as
                // idle cannot still be streaming, so flush the buffer here instead of
                // leaving stale text stuck on screen forever.
                _streaming.value.keys
                    .filter { it.backendId == bid && it !in serverRunning }
                    .forEach { promoteStreaming(it) }
            }

            is WsFrame.ChatChunk -> {
                val key = SessionKey(bid, frame.slot)
                _streaming.update { it + (key to ((it[key] ?: "") + frame.content)) }
                _running.update { it + key }
            }

            is WsFrame.ChatMessage -> {
                val key = SessionKey(bid, frame.slot)
                val msg = frame.message.toModel()
                _messages.update { it + (key to (it[key].orEmpty() + msg)) }
                when (msg.role) {
                    MessageRole.USER -> {
                        _streaming.update { it + (key to "") }
                        _running.update { it + key }
                    }
                    MessageRole.ASSISTANT -> _streaming.update { it - key }
                    else -> Unit
                }
            }

            is WsFrame.ChatDone -> {
                val key = SessionKey(bid, frame.slot)
                promoteStreaming(key)
                _running.update { it - key }
                scope.launch {
                    runCatching { clients[bid]?.refreshSlots() }
                    // Reconcile against the authoritative transcript: this restores anything
                    // the mid-turn trim hid and replaces the provisional promoted bubble.
                    loadMessages(key)
                }
            }

            is WsFrame.ChatError -> {
                val key = SessionKey(bid, frame.slot)
                promoteStreaming(key)
                _lastError.update { it + (key to frame.message) }
                _running.update { it - key }
            }

            is WsFrame.SlotTitle -> _slotsByBackend.update { map ->
                val list = map[bid].orEmpty().map { if (it.key == frame.key) it.copy(title = frame.title) else it }
                map + (bid to list)
            }

            is WsFrame.SlotTags -> _slotsByBackend.update { map ->
                val list = map[bid].orEmpty().map { if (it.key == frame.key) it.copy(tags = frame.tags) else it }
                map + (bid to list)
            }

            is WsFrame.ToolCall, is WsFrame.ToolResult, is WsFrame.ToolUpdate -> Unit
            is WsFrame.ContextUsage -> Unit
            is WsFrame.Notification -> Unit
            WsFrame.Unknown -> Unit
        }
    }

    // -- helpers -----------------------------------------------------------

    /**
     * Turn whatever was streamed for [key] into a real assistant message.
     *
     * The server only sends assistant text as `chat_chunk` deltas and never emits a
     * final assistant `chat_message`; the web UI finalizes its streaming bubble on
     * `chat_done` (_done) instead. Mirror that here, otherwise the reply disappears
     * the moment the turn ends.
     */
    private fun promoteStreaming(key: SessionKey) {
        val pending = _streaming.value[key].orEmpty()
        _streaming.update { it - key }
        if (pending.isBlank()) return
        _messages.update { current ->
            current + (
                key to (
                    current[key].orEmpty() + ChatMessage(
                        role = MessageRole.ASSISTANT,
                        content = pending,
                        timestamp = nowMillis(),
                    )
                    )
                )
        }
    }

    // -- backend CRUD ------------------------------------------------------

    suspend fun addBackend(name: String, baseUrl: String, token: String) {
        val cleaned = baseUrl.trim().trimEnd('/')
        val newBackend = Backend(
            id = "b-" + UUID.randomUUID().toString().take(8),
            name = name.trim().ifBlank { cleaned },
            baseUrl = cleaned,
            token = token.trim(),
        )
        store.save(_backends.value + newBackend)
    }

    suspend fun updateBackend(backend: Backend) {
        store.save(_backends.value.map { if (it.id == backend.id) backend else it })
    }

    suspend fun removeBackend(id: String) {
        store.save(_backends.value.filterNot { it.id == id })
    }

    // -- session operations ------------------------------------------------

    suspend fun refreshAll() {
        clients.values.forEach { runCatching { it.refreshSlots() } }
    }

    suspend fun loadMessages(key: SessionKey) {
        val client = clients[key.backendId] ?: return
        runCatching { client.slotDetail(key.slotKey) }
            .onSuccess { detail ->
                val loaded = detail.messages.map { m -> m.toModel() }
                _messages.update { it + (key to trimInFlightTurn(loaded, key)) }
                _running.update { cur -> if (detail.running == true) cur + key else cur - key }
                _lastError.update { it - key }
            }
            .onFailure { e ->
                _lastError.update { it + (key to (e.message ?: "加载失败")) }
            }
    }

    /**
     * While a turn is still streaming the server also stores that turn's partial
     * assistant text (plus its thinking/tool chatter). The streaming bubble already
     * renders it live, so keep only everything up to the last user message to avoid
     * showing the same text twice. The full turn comes back with the reload that
     * runs when `chat_done` arrives.
     */
    private fun trimInFlightTurn(loaded: List<ChatMessage>, key: SessionKey): List<ChatMessage> {
        if (_streaming.value[key].isNullOrBlank()) return loaded
        val lastUser = loaded.indexOfLast { it.role == MessageRole.USER }
        return if (lastUser >= 0) loaded.take(lastUser + 1) else loaded
    }

    suspend fun send(key: SessionKey, text: String): Result<Unit> {
        val client = clients[key.backendId]
            ?: return Result.failure(IllegalStateException("后端未连接"))
        _lastError.update { it - key }

        // Optimistic: the server streams only assistant/thinking/system text over WS,
        // never echoing the user's own message — the client must show it locally.
        val optimistic = ChatMessage(
            role = MessageRole.USER,
            content = text,
            timestamp = nowMillis(),
            local = true,
        )
        _messages.update { it + (key to (it[key].orEmpty() + optimistic)) }
        _streaming.update { it + (key to "") }
        _running.update { it + key }

        return runCatching { client.sendMessage(key.slotKey, text) }
            .onFailure { e ->
                _lastError.update { it + (key to (e.message ?: "发送失败")) }
                _running.update { it - key }
                _streaming.update { it - key }
                _messages.update { m -> m + (key to m[key].orEmpty().filterNot { msg -> msg.local }) }
            }
    }

    suspend fun stop(key: SessionKey) {
        clients[key.backendId]?.let { runCatching { it.stopSlot(key.slotKey) } }
    }

    suspend fun createSlot(backendId: String): SessionKey? {
        val client = clients[backendId] ?: return null
        return runCatching {
            val dto = client.createSlot()
            runCatching { client.refreshSlots() }
            SessionKey(backendId, dto.key)
        }.getOrNull()
    }

    fun clearError(key: SessionKey) {
        _lastError.update { it - key }
    }
}
