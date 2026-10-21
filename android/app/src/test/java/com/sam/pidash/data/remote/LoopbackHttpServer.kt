package com.sam.pidash.data.remote

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Tiny HTTP/1.1 fixture: JVM-only sockets, no JDK HTTP module or Android runtime. */
internal class LoopbackHttpServer private constructor(address: InetSocketAddress) {
    private val listener = ServerSocket().apply { bind(address) }
    private val connections = ConcurrentHashMap.newKeySet<Socket>()
    private val executor = Executors.newCachedThreadPool { Thread(it, "fixture-http").apply { isDaemon = true } }
    private var handler: (FixtureExchange) -> Unit = {}
    val address: InetSocketAddress get() = listener.localSocketAddress as InetSocketAddress
    fun createContext(@Suppress("UNUSED_PARAMETER") path: String, action: (FixtureExchange) -> Unit) { handler = action }
    fun start() {
        executor.execute {
            while (!listener.isClosed) {
                val socket = try { listener.accept() } catch (_: Exception) { break }
                connections.add(socket)
                executor.execute {
                    try { socket.soTimeout = 5000; handler(FixtureExchange(socket)) }
                    catch (_: Exception) { /* Client cancellation and deliberate truncated responses are test cases. */ }
                    finally { connections.remove(socket); socket.close() }
                }
            }
        }
    }
    fun stop(@Suppress("UNUSED_PARAMETER") delay: Int) {
        listener.close(); connections.forEach { it.close() }; executor.shutdownNow()
    }
    companion object {
        fun create(address: InetSocketAddress, @Suppress("UNUSED_PARAMETER") backlog: Int): LoopbackHttpServer {
            require(address.address.isLoopbackAddress)
            return LoopbackHttpServer(address)
        }
    }
}
internal class FixtureHeaders {
    private val headers = linkedMapOf<String, MutableList<String>>()
    fun add(name: String, value: String) { headers.getOrPut(name.lowercase()) { mutableListOf() }.add(value) }
    fun set(name: String, value: String) { headers[name.lowercase()] = mutableListOf(value) }
    fun getFirst(name: String): String? = headers[name.lowercase()]?.firstOrNull()
    fun lines(): List<String> = headers.flatMap { (name, values) -> values.map { "$name: $it\r\n" } }
}
internal class FixtureExchange(private val socket: Socket) {
    val requestHeaders = FixtureHeaders()
    val responseHeaders = FixtureHeaders()
    val requestMethod: String
    val requestURI: URI
    val requestBody: InputStream
    val responseBody: OutputStream get() = socket.getOutputStream()
    init {
        val input = socket.getInputStream().buffered()
        val line = readLine(input).split(' ')
        require(line.size == 3)
        requestMethod = line[0]; requestURI = URI(line[1])
        while (true) {
            val header = readLine(input)
            if (header.isEmpty()) break
            val colon = header.indexOf(':'); require(colon > 0)
            requestHeaders.add(header.substring(0, colon), header.substring(colon + 1).trim())
        }
        val length = requestHeaders.getFirst("Content-Length")?.toInt() ?: 0
        require(length in 0..1_000_000)
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val count = input.read(body, read, length - read)
            require(count > 0); read += count
        }
        requestBody = ByteArrayInputStream(body)
    }
    fun sendResponseHeaders(status: Int, length: Long) {
        val reason = if (status == 200) "OK" else "Fixture"
        responseHeaders.set("Content-Length", length.toString())
        responseHeaders.set("Connection", "close")
        responseBody.write(("HTTP/1.1 $status $reason\r\n" + responseHeaders.lines().joinToString("") + "\r\n").toByteArray(Charsets.US_ASCII))
        responseBody.flush()
    }
    fun close() { socket.close() }
    private fun readLine(input: InputStream): String {
        val bytes = ByteArrayOutputStream()
        while (true) {
            val byte = input.read(); require(byte >= 0)
            if (byte == 10) break
            if (byte != 13) bytes.write(byte)
            require(bytes.size() < 16384)
        }
        return bytes.toString("US-ASCII")
    }
}
