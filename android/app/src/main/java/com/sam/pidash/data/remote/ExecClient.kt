package com.sam.pidash.data.remote

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.contentOrNull
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * One interactive command on the server, over the dashboard's `/api/exec/ws` PTY bridge.
 *
 * The server never logs the command, its output or the keystrokes, and it kills the process
 * when this socket closes. The client sends keystrokes as opaque data: a password typed in a
 * hidden field passes through exactly like any other input and is not stored anywhere here.
 */
/** What the console needs from a command channel; [ExecClient] is the real one. */
interface InteractiveCommand {
    val events: SharedFlow<ExecClient.Event>
    fun start(command: String, cwd: String, cols: Int = 100, rows: Int = 40)
    fun send(text: String)
    fun interrupt()
    fun close()
}

class ExecClient(private val client: LiveSessionClient) : InteractiveCommand {
    sealed interface Event {
        data object Started : Event
        data class Output(val text: String) : Event
        data class Exited(val code: Int) : Event
        data class Failed(val code: String, val message: String) : Event
    }

    private val _events = MutableSharedFlow<Event>(replay = 0, extraBufferCapacity = 512, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    override val events: SharedFlow<Event> = _events

    private var socket: WebSocket? = null

    override fun start(command: String, cwd: String, cols: Int, rows: Int) {
        if (socket != null) return
        socket = client.openSocketAt("/api/exec/ws", object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(
                    buildJsonObject {
                        put("type", "start")
                        put("command", command)
                        put("cwd", cwd)
                        put("cols", cols)
                        put("rows", rows)
                    }.toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching { pidashJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                when (frame.string("type")) {
                    "started" -> _events.tryEmit(Event.Started)
                    "output" -> frame.string("data")?.let { _events.tryEmit(Event.Output(it)) }
                    "exit" -> _events.tryEmit(Event.Exited(frame["code"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0))
                    "error" -> _events.tryEmit(
                        Event.Failed(frame.string("code") ?: "error", frame.string("message") ?: "命令执行失败"),
                    )
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _events.tryEmit(Event.Failed("connection_failed", t.message ?: "与服务器的连接中断"))
            }
        })
    }

    override fun send(text: String) {
        if (text.isEmpty()) return
        socket?.send(frame("input") { put("data", text) })
    }

    fun resize(cols: Int, rows: Int) {
        socket?.send(frame("resize") { put("cols", cols); put("rows", rows) })
    }

    /** Ctrl-C is a terminal keystroke, so it works even for a program that ignores signals. */
    override fun interrupt() = send("\u0003")

    /** Closing the socket is what stops the server-side process. */
    override fun close() {
        socket?.close(1000, "client closed")
        socket = null
    }

    private fun frame(type: String, fill: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        buildJsonObject { put("type", type); fill() }.toString()

    private fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull
}
