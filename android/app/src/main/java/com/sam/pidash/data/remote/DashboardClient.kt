package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ConnectionState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/**
 * Talks to ONE pi-dashboard server: REST calls + a self-healing WebSocket.
 *
 * The socket loop reconnects with exponential backoff (1s → 30s). Every REST
 * result that also arrives over WS is re-emitted as a frame so callers have a
 * single data path.
 */
class DashboardClient(
    val backend: Backend,
    private val scope: CoroutineScope,
) {
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val _frames = MutableSharedFlow<WsFrame>(extraBufferCapacity = 512)
    val frames: SharedFlow<WsFrame> = _frames

    private val _connection = MutableStateFlow(ConnectionState.Disconnected)
    val connection: StateFlow<ConnectionState> = _connection

    private var socket: WebSocket? = null
    private var loop: Job? = null

    @Volatile
    private var stopped = false

    // -- lifecycle ----------------------------------------------------------

    fun start() {
        if (loop?.isActive == true) return
        stopped = false
        loop = scope.launch {
            var backoff = 1000L
            while (isActive && !stopped) {
                _connection.value = ConnectionState.Connecting
                val wasOpen = runCatching { runSocketOnce() }.getOrDefault(false)
                if (stopped || !isActive) break
                _connection.value = ConnectionState.Error
                if (wasOpen) backoff = 1000L
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(30_000L)
            }
        }
    }

    fun stop() {
        stopped = true
        loop?.cancel()
        loop = null
        socket?.close(1000, "client stopped")
        socket = null
        _connection.value = ConnectionState.Disconnected
    }

    fun close() {
        stop()
        runCatching { http.dispatcher.executorService.shutdown() }
        runCatching { http.connectionPool.evictAll() }
    }

    /** Suspends until the socket closes/fails; returns true if it had opened. */
    private suspend fun runSocketOnce(): Boolean {
        val closed = CompletableDeferred<Unit>()
        var wasOpen = false
        val request = Request.Builder()
            .url(wsUrl())
            .apply { authHeader()?.let { header("Authorization", it) } }
            .build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                wasOpen = true
                _connection.value = ConnectionState.Connected
                scope.launch { runCatching { refreshSlots() } }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                parseWsFrame(text)?.let { _frames.tryEmit(it) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                closed.complete(Unit)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                closed.complete(Unit)
            }
        }

        socket = http.newWebSocket(request, listener)
        return try {
            closed.await()
            wasOpen
        } finally {
            socket = null
        }
    }

    // -- REST --------------------------------------------------------------

    /** Fetches the slot list and emits it as a `slots` frame (single data path). */
    suspend fun refreshSlots() {
        _frames.emit(WsFrame.Slots(listSlots()))
    }

    suspend fun listSlots(): List<SlotDto> = withContext(Dispatchers.IO) {
        pidashJson.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(SlotDto.serializer()),
            execute(getRequest("/api/chat/slots")),
        )
    }

    suspend fun slotDetail(slotKey: String): SlotDetailDto = withContext(Dispatchers.IO) {
        pidashJson.decodeFromString(
            SlotDetailDto.serializer(),
            execute(getRequest("/api/chat/slots/${encodeKey(slotKey)}")),
        )
    }

    suspend fun status(): StatusDto = withContext(Dispatchers.IO) {
        pidashJson.decodeFromString(StatusDto.serializer(), execute(getRequest("/api/status")))
    }

    /** Fire-and-forget: the assistant reply streams back over the WebSocket. */
    suspend fun sendMessage(slotKey: String, text: String) = withContext(Dispatchers.IO) {
        val body = pidashJson.encodeToString(
            SendMessageRequest.serializer(),
            SendMessageRequest(slot = slotKey, message = text),
        )
        execute(jsonRequest("POST", "/api/chat?ws=1", body))
        Unit
    }

    suspend fun stopSlot(slotKey: String) = withContext(Dispatchers.IO) {
        execute(jsonRequest("POST", "/api/chat/slots/${encodeKey(slotKey)}/stop", "{}"))
        Unit
    }

    suspend fun renameSlot(slotKey: String, title: String) = withContext(Dispatchers.IO) {
        val body = pidashJson.encodeToString(RenameSlotRequest.serializer(), RenameSlotRequest(title))
        execute(jsonRequest("PATCH", "/api/chat/slots/${encodeKey(slotKey)}/title", body))
        Unit
    }

    suspend fun createSlot(name: String? = null): SlotDto = withContext(Dispatchers.IO) {
        val body = pidashJson.encodeToString(CreateSlotRequest.serializer(), CreateSlotRequest(name = name))
        pidashJson.decodeFromString(
            SlotDto.serializer(),
            execute(jsonRequest("POST", "/api/chat/slots", body)),
        )
    }

    // -- plumbing ----------------------------------------------------------

    private fun base(): String = backend.baseUrl.trim().trimEnd('/')

    private fun wsUrl(): String {
        val b = base()
        val ws = when {
            b.startsWith("https://") -> "wss://" + b.removePrefix("https://")
            b.startsWith("http://") -> "ws://" + b.removePrefix("http://")
            else -> b
        }
        return "$ws/api/ws"
    }

    private fun url(path: String): String = base() + path

    /** Slot keys are `chat-<n>-<ms>`; encode defensively. */
    private fun encodeKey(key: String): String = java.net.URLEncoder.encode(key, "UTF-8")

    private fun authHeader(): String? {
        val t = backend.token.trim()
        if (t.isEmpty()) return null
        return if (t.startsWith("Bearer ") || t.startsWith("Basic ")) t else "Bearer $t"
    }

    private fun getRequest(path: String): Request =
        Request.Builder()
            .url(url(path))
            .apply { authHeader()?.let { header("Authorization", it) } }
            .get()
            .build()

    private fun jsonRequest(method: String, path: String, body: String): Request =
        Request.Builder()
            .url(url(path))
            .apply { authHeader()?.let { header("Authorization", it) } }
            .method(method, body.toRequestBody(JSON_MEDIA))
            .build()

    private fun execute(request: Request): String {
        http.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                throw IOException("HTTP ${res.code}" + if (text.isNotBlank()) ": ${text.take(200)}" else "")
            }
            return text
        }
    }

    companion object {
        /** Probe a candidate server before saving it. */
        suspend fun testConnection(baseUrl: String, token: String): Result<String> =
            withContext(Dispatchers.IO) {
                runCatching {
                    val probe = DashboardClient(
                        Backend(id = "probe", name = "probe", baseUrl = baseUrl, token = token),
                        CoroutineScope(Dispatchers.IO),
                    )
                    try {
                        val s = probe.status()
                        s.version?.let { "连接成功 · v$it" } ?: "连接成功"
                    } finally {
                        probe.close()
                    }
                }
            }
    }
}
