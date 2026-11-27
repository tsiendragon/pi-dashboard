package com.sam.pidash.data.remote

import com.sam.pidash.data.local.LiveCookieStore
import com.sam.pidash.domain.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class LiveApiException(val status: Int, val code: String, message: String) : IOException(message)

/** Root-relative APIs, pinned origin, no redirect/retry and no host-wide control token. */
class LiveSessionClient(
    val backend: Backend,
    private val cookies: LiveCookieStore,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(35, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build(),
) {
    private val base = validateLiveBaseUrl(backend.baseUrl)
    private val origin = base.newBuilder().encodedPath("/").query(null).fragment(null).build().toString().trimEnd('/')
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    /** A stored session cookie from a previous token sign-in. */
    val authorized: Boolean get() = cookies.load(backend) != null

    private fun request(path: String, method: String = "GET", body: JsonElement? = null, authenticate: Boolean = true): Request {
        require(path.startsWith("/api/") && !path.contains('\r') && !path.contains('\n'))
        val url = (base.toString().trimEnd('/') + path).toHttpUrl()
        require(url.scheme == base.scheme && url.host == base.host && url.port == base.port)
        return Request.Builder().url(url).header("Cache-Control", "no-store")
            .header("Origin", origin)
            .apply {
                edgeAuthorization(backend.token)?.let { header("Authorization", it) }
                if (authenticate) cookies.load(backend)?.let { header("Cookie", "pi_live_session=$it") }
            }
            .method(method, if (method == "GET") null else (body ?: buildJsonObject {}).toString().toRequestBody(jsonMedia))
            .build()
    }

    private fun responseText(response: Response): String {
        val body = response.body ?: return ""
        val limit = 16L * 1024 * 1024
        if (body.contentLength() > limit) throw IOException("Live 响应超出大小限制")
        val source = body.source()
        source.request(limit + 1)
        if (source.buffer.size > limit) throw IOException("Live 响应超出大小限制")
        return source.readUtf8()
    }

    private fun executeElement(request: Request, acceptCookie: Boolean = false): JsonElement {
        http.newCall(request).execute().use { response ->
            val text = responseText(response)
            val parsed = runCatching { pidashJson.parseToJsonElement(text) }.getOrNull()
            if (!response.isSuccessful) {
                val obj = parsed as? JsonObject
                val code = obj?.get("error")?.jsonPrimitive?.contentOrNull ?: "http_${response.code}"
                if (response.code == 401 && code == "authentication_required") cookies.save(backend, null)
                val message = obj?.get("message")?.jsonPrimitive?.contentOrNull
                    ?: when {
                        response.code == 401 -> "Live 授权失效或服务器凭据无效，请检查连接并重新配对"
                        response.code == 423 -> "此会话由其他客户端接管，未抢占控制权"
                        response.code == 404 -> "Live 接口或会话不存在；请确认服务器已更新"
                        else -> "Live 请求失败：HTTP ${response.code}"
                    }
                throw LiveApiException(response.code, code, message)
            }
            if (parsed == null) throw IOException("服务器返回了无效 JSON；可能仍是旧版后端")
            if (acceptCookie) {
                val cookie = response.headers.values("Set-Cookie").mapNotNull { Cookie.parse(request.url, it) }
                    .singleOrNull { it.name == "pi_live_session" && it.value.matches(Regex("[a-f0-9]{64}")) &&
                        it.httpOnly && it.expiresAt > System.currentTimeMillis() && (!request.url.isHttps || it.secure) }
                    ?: throw IOException("配对响应缺少有效授权 Cookie")
                cookies.save(backend, cookie.value)
            }
            return parsed
        }
    }

    private fun execute(request: Request, acceptCookie: Boolean = false): JsonObject {
        val parsed = executeElement(request, acceptCookie)
        if (parsed !is JsonObject) throw IOException("服务器未返回 Live JSON；可能仍是旧版后端")
        return parsed
    }

    private fun filePathValid(path: String): Boolean =
        path.length <= 4096 && path.isNotBlank() && !path.contains('\u0000') &&
            (path.startsWith('/') || path.startsWith("~/"))

    /** Plain-text file preview (`/api/file-read` answers text/plain, not JSON). */
    suspend fun readTextFile(path: String, limit: Int = 512 * 1024): String = withContext(Dispatchers.IO) {
        require(filePathValid(path)) { "无效文件路径" }
        val query = java.net.URLEncoder.encode(path, "UTF-8")
        executeText(request("/api/file-read?path=" + query + "&tail=" + limit))
    }

    /** Raw bytes for the native PDF renderer; the server sends them only for `raw=1`. */
    suspend fun readBinaryFile(path: String, maxBytes: Int = 32 * 1024 * 1024): ByteArray = withContext(Dispatchers.IO) {
        require(filePathValid(path)) { "无效文件路径" }
        val query = java.net.URLEncoder.encode(path, "UTF-8")
        executeBytes(request("/api/file-read?raw=1&path=" + query), maxBytes)
    }
    private fun executeText(request: Request): String {
        http.newCall(request).execute().use { response ->
            val text = responseText(response)
            if (!response.isSuccessful) throw LiveApiException(response.code, "file_read_failed",
                when (response.code) {
                    404 -> "文件不存在或已被删除"
                    403 -> "服务器拒绝读取该文件"
                    413 -> "文件过大，无法在 App 内预览"
                    else -> "读取文件失败：HTTP ${response.code}"
                })
            return text
        }
    }
    private fun executeBytes(request: Request, limit: Int): ByteArray {
        http.newCall(request).execute().use { response ->
            val body = response.body
            val declared = body?.contentLength() ?: 0L
            if (!response.isSuccessful) {
                val text = responseText(response)
                val code = runCatching { pidashJson.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                    ?: "file_read_failed"
                throw LiveApiException(response.code, code, when (response.code) {
                    404 -> "文件不存在或已被删除"
                    403 -> "服务器拒绝读取该文件"
                    413 -> "文件过大，无法在 App 内预览"
                    else -> "读取文件失败：HTTP ${response.code}"
                })
            }
            if (body == null) throw IOException("服务器没有返回文件内容")
            if (declared > limit) throw IOException("文件过大，无法在 App 内预览")
            val contentType = response.header("Content-Type").orEmpty()
            if (contentType.startsWith("text/", ignoreCase = true) || contentType.contains("json", ignoreCase = true)) {
                throw IOException("服务器没有返回 PDF 原始数据；请更新并重启 Dashboard")
            }
            val bytes = body.bytes()
            if (bytes.size > limit) throw IOException("文件过大，无法在 App 内预览")
            return bytes
        }
    }

    suspend fun get(path: String): JsonObject = withContext(Dispatchers.IO) {
        execute(request(path)).jsonObject
    }

    /** Skills available to this session's cwd; includes project skills when the server supports cwd. */
    suspend fun skills(cwd: String?): List<LiveSkill> = withContext(Dispatchers.IO) {
        val suffix = cwd?.trim()?.takeIf { it.isNotBlank() }?.let {
            "?cwd=" + java.net.URLEncoder.encode(it, "UTF-8")
        }.orEmpty()
        val element = executeElement(request("/api/skills" + suffix))
        pidashJson.decodeFromJsonElement(ListSerializer(LiveSkill.serializer()), element)
    }

    /** Upload whole documents to the Dashboard host; the returned paths go into the prompt. */
    suspend fun uploadFiles(files: List<FileAttachments.UploadRequest>): List<String> = withContext(Dispatchers.IO) {
        require(files.isNotEmpty()) { "没有待上传的文件" }
        val body = buildJsonObject {
            putJsonArray("files") {
                files.forEach { file ->
                    add(buildJsonObject {
                        put("name", file.name)
                        put("data", file.data)
                    })
                }
            }
        }
        val result = post("/api/upload-files", body)
        val paths = (result["paths"] as? JsonArray).orEmpty().mapNotNull { element ->
            (element as? JsonPrimitive)?.contentOrNull?.takeIf { it.startsWith("/") }
        }
        if (paths.size != files.size) throw IOException("服务器未返回全部上传路径")
        paths
    }
    suspend fun post(path: String, body: JsonElement = buildJsonObject {}): JsonObject = withContext(Dispatchers.IO) {
        execute(request(path, "POST", body)).jsonObject
    }
    /**
     * Sign in with the dashboard control token — the same secret the web UI uses.
     * There is no pairing code: the token buys one HttpOnly session cookie, and the
     * cookie is what this app keeps.
     */
    suspend fun authenticate(token: String) = withContext(Dispatchers.IO) {
        val value = token.trim()
        require(value.matches(Regex("[a-fA-F0-9]{64}"))) { "访问令牌是 64 位十六进制字符串，请从 live-control-token 文件复制" }
        execute(request("/api/live-sessions/auth", "POST", buildJsonObject { put("token", value.lowercase()) }, false), true)
        Unit
    }
    suspend fun signOut() = withContext(Dispatchers.IO) {
        try { execute(request("/api/live-sessions/auth", "DELETE")) }
        finally { cookies.save(backend, null) }
        Unit
    }
    suspend fun list(): List<LiveSummary> {
        val obj = get("/api/live-sessions")
        return pidashJson.decodeFromJsonElement(ListSerializer(LiveSummary.serializer()),
            obj["sessions"] ?: throw IOException("缺少 Live 会话列表"))
    }
    /** Cheap host CPU/memory sample for the machine list; read-only and unauthenticated like /api/system. */
    suspend fun machineLoad(): MachineLoad = pidashJson.decodeFromJsonElement(
        MachineLoad.serializer(), get("/api/system/load"))

    /** Providers/models from pi's models.json, with secrets omitted by the server. */
    suspend fun modelProviders(): List<ModelProvider> = withContext(Dispatchers.IO) {
        val response = get("/api/model-config/providers")
        pidashJson.decodeFromJsonElement(
            ListSerializer(ModelProvider.serializer()),
            response["providers"] ?: JsonArray(emptyList()),
        )
    }

    /** Save one provider (including its model list) through the protected config route. */
    suspend fun saveModelProvider(id: String, request: ModelProviderRequest): ModelProviderSaveResult = withContext(Dispatchers.IO) {
        require(id.matches(Regex("[a-z0-9][a-z0-9._-]{0,63}"))) { "无效的服务商标识" }
        val body = buildJsonObject {
            put("api", request.api)
            put("baseUrl", request.baseUrl)
            request.apiKey?.takeIf { it.isNotBlank() }?.let { put("apiKey", it) }
            putJsonArray("models") {
                request.models.forEach { model ->
                    add(buildJsonObject {
                        put("id", model.id)
                        model.name?.takeIf { it.isNotBlank() }?.let { put("name", it) }
                        if (model.contextWindow > 0) put("contextWindow", model.contextWindow)
                        if (model.maxTokens > 0) put("maxTokens", model.maxTokens)
                        put("reasoning", model.reasoning)
                        putJsonArray("input") { model.input.forEach { add(JsonPrimitive(it)) } }
                    })
                }
            }
        }
        pidashJson.decodeFromJsonElement(
            ModelProviderSaveResult.serializer(),
            execute(request("/api/model-config/providers/" + id, "PUT", body)).jsonObject,
        )
    }

    /** Whether this server has a DashScope key for voice input; the key itself never leaves it. */
    suspend fun asrConfig(): AsrConfig = pidashJson.decodeFromJsonElement(
        AsrConfig.serializer(), get("/api/asr/config"))

    /** Clean up a final ASR transcript with the server's small model. */
    suspend fun polishVoice(text: String, context: VoicePolishContext?): VoicePolishResult = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("text", text)
            if (context != null) put("context", buildJsonObject {
                context.title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
                context.cwd?.takeIf { it.isNotBlank() }?.let { put("cwd", it) }
                context.draft?.takeIf { it.isNotBlank() }?.let { put("draft", it) }
                if (context.recent.isNotEmpty()) putJsonArray("recent") {
                    context.recent.forEach { message ->
                        add(buildJsonObject { put("role", message.role); put("text", message.text) })
                    }
                }
            })
        }
        pidashJson.decodeFromJsonElement(VoicePolishResult.serializer(), post("/api/asr/polish", body))
    }
    suspend fun detail(id: String, compact: Boolean = true): LiveDetail = pidashJson.decodeFromJsonElement(
        LiveDetail.serializer(),
        get(path(id) + if (compact) "?compact=1" else ""),
    )
    suspend fun meta(): Map<String, LiveMeta> = pidashJson.decodeFromJsonElement(
        MapSerializer(String.serializer(), LiveMeta.serializer()), get("/api/live-session-meta")["meta"] ?: buildJsonObject {})
    suspend fun candidates(): List<LiveRepoCandidate> = pidashJson.decodeFromJsonElement(
        ListSerializer(LiveRepoCandidate.serializer()), get("/api/live-sessions/repo-candidates")["repos"] ?: JsonArray(emptyList()))
    private fun decodeGroups(response: JsonObject): List<LiveGroup> = try {
        pidashJson.decodeFromJsonElement(ListSerializer(LiveGroup.serializer()),
            response["groups"] ?: throw IOException("服务器未提供分组结果"))
    } catch (error: kotlinx.serialization.SerializationException) { throw IOException("无法确认服务器分组结果", error) }
    /** Monthly usage ledger for this dashboard; `month` is `YYYY-MM`. */
    suspend fun usage(month: String? = null): LiveUsageReport = withContext(Dispatchers.IO) {
        month?.let { require(it.matches(Regex("\\d{4}-\\d{2}"))) { "月份格式应为 YYYY-MM" } }
        val path = if (month != null) "/api/usage?month=$month" else "/api/usage"
        pidashJson.decodeFromJsonElement(LiveUsageReport.serializer(), get(path))
    }

    /** Fork family of one session file; read-only, keyed by session file path. */
    suspend fun sessionTree(sessionFile: String): LiveSessionTree = withContext(Dispatchers.IO) {
        require(sessionFile.startsWith('/') && sessionFile.length <= 4096 && !sessionFile.contains('\u0000')) {
            "无效会话文件路径"
        }
        val query = java.net.URLEncoder.encode(sessionFile, "UTF-8")
        pidashJson.decodeFromJsonElement(LiveSessionTree.serializer(), get("/api/session-tree?file=$query"))
    }

    /** Requests a graceful Dashboard restart; systemd brings the updated process back. */
    suspend fun restartDashboard() = withContext(Dispatchers.IO) {
        post("/api/dashboard/restart")
        Unit
    }

    suspend fun organization(): LiveOrganization {
        val groups = decodeGroups(get("/api/live-session-groups"))
        val order = pidashJson.decodeFromJsonElement(LiveOrder.serializer(), get("/api/live-session-order"))
        return LiveOrganization(groups, order, loaded = true)
    }
    suspend fun saveOrder(order: List<String>): LiveOrder = withContext(Dispatchers.IO) {
        val response = execute(request("/api/live-session-order", "PUT", buildJsonObject {
            put("order", JsonArray(order.map(::JsonPrimitive)))
        })).jsonObject
        if (response["order"] !is JsonArray) throw IOException("服务器未提供排序结果")
        pidashJson.decodeFromJsonElement(LiveOrder.serializer(), response)
    }
    suspend fun createGroup(name: String): List<LiveGroup> = decodeGroups(
        post("/api/live-session-groups", buildJsonObject { put("name", name) }))
    suspend fun moveGroup(process: String, groupId: String, removeSessionId: String? = null): List<LiveGroup> = withContext(Dispatchers.IO) {
        require(groupId.matches(Regex("[A-Za-z0-9_-]{1,160}"))) { "无效分组标识" }
        val path = "/api/live-session-groups/$groupId/members"
        val response = if (removeSessionId == null) execute(request(path, "POST", buildJsonObject { put("processInstanceId", process) }))
            else {
                require(removeSessionId.matches(Regex("[A-Za-z0-9_-]{1,160}"))) { "无效会话标识" }
                execute(request("$path/$removeSessionId", "DELETE"))
            }
        decodeGroups(response.jsonObject)
    }
    suspend fun startOptions(): LiveStartOptions = pidashJson.decodeFromJsonElement(
        LiveStartOptions.serializer(), get("/api/live-sessions/start-options"))
    suspend fun start(cwd: String, title: String, model: String, thinkingLevel: String): String? {
        require(cwd.startsWith('/') && !cwd.contains('\u0000')) { "请选择或输入绝对工作目录" }
        val obj = post("/api/live-sessions/start", buildJsonObject {
            put("cwd", cwd.trim())
            if (title.isNotBlank()) put("title", title.trim())
            if (model.isNotBlank()) put("model", model.trim())
            if (thinkingLevel.isNotBlank()) put("thinkingLevel", thinkingLevel)
        })
        return obj["result"]?.jsonObject?.get("processInstanceId")?.jsonPrimitive?.contentOrNull
    }
    suspend fun command(id: String, value: JsonObject): JsonElement {
        val sudo = value["type"]?.jsonPrimitive?.contentOrNull == "answer_sudo"
        if (sudo && (value["cancelled"]?.jsonPrimitive?.booleanOrNull != true || value.containsKey("password"))) {
            require(base.isHttps) { "管理员密码仅能通过 HTTPS 连接提交，请先配置 HTTPS 后端" }
        }
        return try {
            post(path(id) + "/commands", buildJsonObject { put("command", value) })["result"] ?: JsonNull
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (sudo && e is LiveApiException) throw LiveApiException(e.status, "sudo_answer_failed", "授权提交失败，请检查请求状态；不要自动重复执行")
            if (sudo) throw IOException("授权提交失败，请检查请求状态；不要自动重复执行")
            throw e
        }
    }
    suspend fun claim(id: String): LiveLease = pidashJson.decodeFromJsonElement(LiveLease.serializer(),
        post(path(id) + "/claim", buildJsonObject { put("requestedLeaseMs", 30_000) })["result"] ?: JsonNull)
    suspend fun renew(id: String, lease: String): LiveLease = pidashJson.decodeFromJsonElement(LiveLease.serializer(),
        post(path(id) + "/renew", buildJsonObject { put("leaseId", lease) })["result"] ?: JsonNull)
    suspend fun release(id: String, lease: String) { post(path(id) + "/release", buildJsonObject { put("leaseId", lease) }) }
    suspend fun patchMeta(id: String, tags: List<String>?, pinned: Boolean?, emoji: String?, color: String? = null) = withContext(Dispatchers.IO) {
        execute(request(path(id) + "/meta", "PATCH", buildJsonObject {
            tags?.let { put("tags", JsonArray(it.map(::JsonPrimitive))) }
            pinned?.let { put("pinned", it) }
            emoji?.let { put("emoji", it) }
            color?.let { put("color", it) }
        }))
        Unit
    }

    fun openSocket(listener: WebSocketListener, compact: Boolean = true): WebSocket =
        openSocketAt("/api/live-sessions/ws" + if (compact) "?compact=1" else "", listener)

    /** The server bridges this stream to DashScope; the app sends only PCM audio frames. */
    fun openAsrSocket(listener: WebSocketListener): WebSocket = openSocketAt("/api/asr/realtime", listener)

    /** Same auth (Bearer + Live cookie) on any dashboard WebSocket path. */
    fun openSocketAt(path: String, listener: WebSocketListener): WebSocket {
        val regular = request(path)
        val ws = regular.url.newBuilder().scheme(if (base.isHttps) "https" else "http").build()
        return http.newWebSocket(regular.newBuilder().url(ws).build(), listener)
    }
    fun close() {
        http.dispatcher.cancelAll()
        http.connectionPool.evictAll()
        http.dispatcher.executorService.shutdown()
    }
    fun path(id: String): String {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,160}"))) { "无效的 Live 进程标识" }
        return "/api/live-sessions/$id"
    }
}

internal fun validateLiveBaseUrl(raw: String): HttpUrl {
    val url = raw.trim().trimEnd('/').toHttpUrl()
    require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) { "服务器地址不能包含凭据或查询参数" }
    // A native pairing code/cookie must never travel as cleartext on LAN/public networks.
    require(url.isHttps || url.host in setOf("127.0.0.1", "localhost", "::1")) { "Live 配对必须使用 HTTPS（本机回环测试除外）" }
    return url
}

internal fun edgeAuthorization(raw: String): String? = raw.trim().takeIf { it.isNotEmpty() }?.let {
    require(!it.contains('\r') && !it.contains('\n')) { "服务器凭据含无效字符" }
    if (it.startsWith("Bearer ") || it.startsWith("Basic ")) it else "Bearer $it"
}
