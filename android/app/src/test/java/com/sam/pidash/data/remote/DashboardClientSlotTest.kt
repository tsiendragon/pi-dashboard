package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.Backend
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * A one-request local HTTP server instead of a live dashboard: asserts the close-slot
 * request contract (method, path, auth) that the Chat page relies on.
 */
class DashboardClientSlotTest {
    private lateinit var server: ServerSocket
    @Volatile private var method = ""
    @Volatile private var path = ""
    @Volatile private var body = ""
    @Volatile private var authorization: String? = null

    @Before fun startServer() {
        server = ServerSocket(0)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                runCatching {
                    server.accept().use { socket ->
                        val input = socket.getInputStream().bufferedReader()
                        val requestLine = input.readLine().orEmpty().split(' ')
                        method = requestLine.getOrElse(0) { "" }
                        path = requestLine.getOrElse(1) { "" }
                        var length = 0
                        while (true) {
                            val line = input.readLine() ?: break
                            if (line.isEmpty()) break
                            if (line.startsWith("Authorization:", ignoreCase = true)) {
                                authorization = line.substringAfter(':').trim()
                            }
                            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                                length = line.substringAfter(':').trim().toIntOrNull() ?: 0
                            }
                        }
                        if (length > 0) {
                            val buffer = CharArray(length)
                            var read = 0
                            while (read < length) {
                                val n = input.read(buffer, read, length - read)
                                if (n < 0) break
                                read += n
                            }
                            body = String(buffer, 0, read)
                        }
                        socket.getOutputStream().apply {
                            write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                            flush()
                        }
                    }
                }
            }
        }
    }

    @After fun stopServer() { server.close() }

    private fun client(token: String = "") = DashboardClient(
        Backend("b1", "local", "http://127.0.0.1:${server.localPort}", token),
        CoroutineScope(Dispatchers.Default),
    )

    @Test fun closeSlotSendsDeleteToTheSlotAndKeepsTheAuthHeader() = runBlocking {
        client(token = "secret").deleteSlot("chat-7-1700000000000")
        assertEquals("DELETE", method)
        assertEquals("/api/chat/slots/chat-7-1700000000000", path)
        assertEquals("Bearer secret", authorization)
        assertTrue(body.isEmpty() || body == "{}")
    }

    @Test fun stopSlotStillPostsToTheStopEndpoint() = runBlocking {
        client().stopSlot("chat-8-1")
        assertEquals("POST", method)
        assertEquals("/api/chat/slots/chat-8-1/stop", path)
    }
}
