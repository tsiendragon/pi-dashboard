package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.*
import kotlinx.serialization.json.*
import java.time.Instant

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun eventIdentity(event: JsonObject): String? {
    val data = event.obj("data") ?: return null
    val message = data.obj("message")
    return data.str("messageId") ?: data.str("toolCallId") ?: data.str("id") ?: message?.str("id")
        ?: if (event.str("type").orEmpty().startsWith("message_")) message?.str("role")?.let { "message:$it" }
        else data.str("toolName")?.let { "tool:$it" }
}
private fun messageOf(entry: JsonObject): JsonObject? = when (entry.str("type")) {
    "message" -> entry.obj("message")
    "message_update", "message_end" -> entry.obj("data")?.obj("message")
    else -> null
}
private fun samePersistedMessage(a: JsonObject, b: JsonObject): Boolean {
    val first = messageOf(a) ?: return false
    val second = messageOf(b) ?: return false
    val firstId = if (a.str("type") == "message") a.str("id") else a.obj("data")?.str("entryId")
    val secondId = if (b.str("type") == "message") b.str("id") else b.obj("data")?.str("entryId")
    if (firstId != null && secondId != null && firstId != secondId) return false
    // Text equality alone is NOT identity: consecutive identical user messages are legitimate.
    return first == second && (first["timestamp"] != null || first.str("id") != null)
}

private fun append(entries: MutableList<JsonElement>, event: JsonObject) {
    val type = event.str("type") ?: return
    if (type in setOf("message_start", "summary_update", "extension_ui", "extension_ui_closed", "extension_ui_notify")) return
    if (type == "message_entry") {
        val entryId = event.obj("data")?.str("entryId") ?: return
        val index = entries.indexOfLast { (it as? JsonObject)?.str("type") == "message_end" }
        if (index >= 0) {
            val carrier = entries[index] as JsonObject
            entries[index] = JsonObject(carrier + ("data" to JsonObject(carrier.obj("data").orEmpty() + ("entryId" to JsonPrimitive(entryId)))))
        }
        return
    }
    val identity = eventIdentity(event)
    fun matches(candidate: JsonElement, expected: String): Boolean {
        val obj = candidate as? JsonObject ?: return false
        return obj.str("type") == expected && (identity == null || eventIdentity(obj) == identity)
    }
    when (type) {
        "message_update", "tool_execution_update" -> {
            val index = entries.indexOfLast { matches(it, type) }
            if (index >= 0) entries[index] = event else entries.add(event)
        }
        "message_end" -> {
            entries.removeAll { matches(it, "message_update") }
            if (entries.takeLast(3).none { it is JsonObject && samePersistedMessage(it, event) }) entries.add(event)
        }
        "tool_execution_end" -> {
            entries.removeAll { matches(it, "tool_execution_start") || matches(it, "tool_execution_update") }
            entries.add(event)
        }
        "tool_execution_start" -> entries.add(event)
        "live_feature_snapshot" -> {
            val feature = event.obj("data")?.str("feature")
            val index = entries.indexOfLast { it is JsonObject && it.str("type") == type && it.obj("data")?.str("feature") == feature }
            if (index >= 0) entries[index] = event else entries.add(event)
        }
        else -> entries.add(event)
    }
    if (entries.size > 1000) entries.subList(0, entries.size - 1000).clear()
}

/** null requests an authoritative snapshot after a sequence gap. No optimistic transcript. */
fun reduceLiveEvent(detail: LiveDetail, message: JsonObject): LiveDetail? {
    if (message.str("processInstanceId") != detail.summary.processInstanceId || message.str("type") != "event") return detail
    val sequence = (message["sequence"] as? JsonPrimitive)?.longOrNull ?: return detail
    if (sequence <= detail.summary.eventSequence) return detail
    if (sequence != detail.summary.eventSequence + 1) return null
    val event = message.obj("event") ?: return detail
    val type = event.str("type") ?: return detail
    val data = event.obj("data") ?: buildJsonObject {}
    var summary = detail.summary.copy(eventSequence = sequence)
    when (type) {
        "agent_start" -> summary = summary.copy(status = "running")
        "agent_settled" -> summary = summary.copy(status = "idle")
        "session_info_changed" -> if ("name" in data) summary = summary.copy(sessionName = data.str("name"))
        "model_select" -> runCatching { pidashJson.decodeFromJsonElement<LiveModel>(data.getValue("model")) }.getOrNull()?.let { summary = summary.copy(model = it) }
        "thinking_level_select" -> data.str("level")?.let { summary = summary.copy(thinkingLevel = it) }
        "summary_update" -> {
            data.str("status")?.takeIf { it in setOf("idle", "running", "reconnecting") }?.let { summary = summary.copy(status = it) }
            if ("contextUsage" in data) {
                val usage = runCatching { pidashJson.decodeFromJsonElement<LiveContextUsage?>(data.getValue("contextUsage")) }.getOrNull()
                summary = summary.copy(contextUsage = usage)
            }
        }
    }
    var pending = detail.pendingUi
    if (type == "extension_ui") {
        val request = runCatching { pidashJson.decodeFromJsonElement<LiveUiRequest>(data) }.getOrNull()
        if (request != null && request.method in setOf("confirm", "select", "input", "editor")) pending = pending.filterNot { it.id == request.id } + request
    }
    if (type == "extension_ui_closed") pending = pending.filterNot { it.id == data.str("id") }
    val entries = detail.entries.toMutableList()
    append(entries, JsonObject(event + ("sequence" to JsonPrimitive(sequence))))
    return detail.copy(summary = summary, entries = entries, pendingUi = pending)
}

private fun timestamp(value: JsonElement?): Long {
    val primitive = value as? JsonPrimitive ?: return 0
    return primitive.longOrNull ?: runCatching { Instant.parse(primitive.content).toEpochMilli() }.getOrDefault(0)
}
private fun textParts(content: JsonElement?): String = when (content) {
    is JsonPrimitive -> content.contentOrNull.orEmpty()
    is JsonArray -> content.mapNotNull { part ->
        val obj = part as? JsonObject ?: return@mapNotNull null
        when (obj.str("type")) {
            "text" -> obj.str("text")
            "image" -> "[图片：请在 WebUI 查看原图]"
            "toolCall" -> "工具 ${obj.str("name").orEmpty()}\n${obj["arguments"] ?: JsonObject(emptyMap())}"
            else -> null
        }
    }.joinToString("\n")
    else -> ""
}

/** Real image parts of one message; never synthesised. */
private fun imageParts(content: JsonElement?): List<LiveImage> = (content as? JsonArray).orEmpty().mapNotNull { part ->
    val obj = part as? JsonObject ?: return@mapNotNull null
    if (obj.str("type") != "image") return@mapNotNull null
    val mime = obj.str("mimeType")?.takeIf { it.startsWith("image/") } ?: return@mapNotNull null
    val data = obj.str("data")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
    LiveImage(mime, data)
}

private fun preview(value: String): String = if (value.length > 65_536)
    value.take(65_536) + "\n（长内容已截断；完整内容请使用 WebUI）" else value

/** Snapshot rows and streaming rows use the same projection; no event id is a fork entry id. */
fun projectLiveTimeline(detail: LiveDetail): List<LiveTimelineItem> {
    val entries = mutableListOf<JsonElement>()
    detail.entries.forEach { raw ->
        val obj = raw as? JsonObject ?: return@forEach
        if (obj.str("type") == "message") entries.add(obj) else append(entries, obj)
    }
    // A tool start plus its latest partial are one visible card with a stable key.
    val visible = mutableListOf<JsonElement>()
    val toolPositions = mutableMapOf<String, Int>()
    entries.takeLast(1000).forEach { raw ->
        val obj = raw as? JsonObject
        val id = obj?.obj("data")?.str("toolCallId")?.takeIf { obj.str("type").orEmpty().startsWith("tool_execution_") }
        val previousIndex = id?.let { toolPositions[it] }
        if (previousIndex != null) {
            val previous = visible[previousIndex] as JsonObject
            visible[previousIndex] = JsonObject(obj + ("data" to JsonObject(previous.obj("data").orEmpty() + obj.obj("data").orEmpty())))
        } else {
            if (id != null) toolPositions[id] = visible.size
            visible.add(raw)
        }
    }
    val completedTools = visible.mapNotNull { raw ->
        val message = (raw as? JsonObject)?.let(::messageOf)
        message?.takeIf { it.str("role") == "toolResult" }?.str("toolCallId")
    }.toSet()
    return visible.mapIndexedNotNull { index, raw ->
        val entry = raw as? JsonObject ?: return@mapIndexedNotNull null
        val type = entry.str("type") ?: return@mapIndexedNotNull null
        val data = entry.obj("data") ?: buildJsonObject {}
        val message = messageOf(entry)
        if (message != null) {
            val role = message.str("role") ?: return@mapIndexedNotNull null
            val content = message["content"]
            val text = textParts(content)
            val thoughts = (content as? JsonArray)?.mapNotNull { part ->
                (part as? JsonObject)?.takeIf { it.str("type") == "thinking" }?.str("thinking")
            }?.joinToString("\n")?.takeIf { it.isNotBlank() }
            val errorMessage = message.str("errorMessage")?.takeIf { it.isNotBlank() }
                ?: if (message.str("stopReason") == "error") "模型请求失败，服务端未提供详细原因。" else null
            val toolFailed = (message["isError"] as? JsonPrimitive)?.booleanOrNull == true
            val entryId = (if (type == "message") entry.str("id") else data.str("entryId"))?.takeIf { it.isNotBlank() }
            val images = imageParts(content)
            if (text.isBlank() && thoughts == null && errorMessage.isNullOrBlank() && !toolFailed && images.isEmpty()) return@mapIndexedNotNull null
            LiveTimelineItem(
                id = entryId ?: "message-${entry.str("sequence") ?: index}-$role",
                role = if (role == "toolResult") "tool" else role,
                text = preview(listOfNotNull(text.takeIf { it.isNotBlank() }, errorMessage).joinToString("\n")
                    .ifBlank { if (toolFailed) "工具执行失败，未提供详细输出。" else "" }),
                timestamp = timestamp(message["timestamp"] ?: entry["timestamp"]),
                thinking = thoughts?.let(::preview),
                toolName = message.str("toolName"),
                isError = toolFailed || errorMessage != null,
                entryId = entryId,
                forkable = role == "user" && entryId != null,
                channel = data.str("channel") ?: message.str("channel") ?: entry.str("channel"),
                status = if (errorMessage != null || toolFailed) "error" else if (type == "message_update") "running" else "done",
                intermediate = (content as? JsonArray)?.any { (it as? JsonObject)?.str("type") in setOf("thinking", "toolCall") } == true,
                images = images,
            )
        } else if (type.startsWith("tool_execution_")) {
            if (data.str("toolCallId") in completedTools) return@mapIndexedNotNull null
            val result = data.obj("result") ?: data.obj("partialResult")
            val output = textParts(result?.get("content"))
            val args = data["args"]?.toString()
            val body = listOfNotNull(args, output.takeIf { it.isNotBlank() }).joinToString("\n")
            LiveTimelineItem(
                id = "tool-${data.str("toolCallId") ?: entry.str("sequence") ?: index}", role = "tool",
                text = preview(body.ifBlank { if (type == "tool_execution_end") "已完成" else "执行中…" }),
                toolName = data.str("toolName") ?: "tool", isError = (data["isError"] as? JsonPrimitive)?.booleanOrNull == true,
                status = if ((data["isError"] as? JsonPrimitive)?.booleanOrNull == true) "error" else if (type == "tool_execution_end") "done" else "running",
            )
        } else if (type == "error") {
            LiveTimelineItem("error-$index", "system", data.str("message") ?: "会话出错", isError = true)
        } else null
    }
}
