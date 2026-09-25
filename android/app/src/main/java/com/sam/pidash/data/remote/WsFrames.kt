package com.sam.pidash.data.remote

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Shared JSON config: tolerant of server-side additions. */
val pidashJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

// ---------------------------------------------------------------------------
// WS `data` payloads (all frames are `{ "type": ..., "data": ... }`)
// ---------------------------------------------------------------------------

@Serializable
data class WsChatChunkData(val slot: String, val content: String = "", val seq: Int? = null)

@Serializable
data class WsChatMessageData(
    val slot: String,
    val role: String? = null,
    val content: String? = null,
    val ts: String? = null,
    val meta: MessageMetaDto? = null,
)

@Serializable
data class WsChatDoneData(val slot: String)

@Serializable
data class WsChatErrorData(val slot: String, val message: String = "")

@Serializable
data class WsToolCallData(
    val slot: String,
    val tool: String = "",
    val id: String = "",
    val args: JsonElement? = null,
)

@Serializable
data class WsToolResultData(
    val slot: String,
    val tool: String = "",
    val id: String = "",
    val result: String? = null,
    val isError: Boolean? = null,
)

@Serializable
data class WsToolUpdateData(
    val slot: String,
    val tool: String? = null,
    val id: String = "",
    val partial: String? = null,
)

@Serializable
data class WsSlotTitleData(val key: String, val title: String = "")

@Serializable
data class WsSlotTagsData(val key: String, val tags: List<String> = emptyList())

@Serializable
data class WsContextUsageData(
    val slot: String,
    val tokens: Int? = null,
    val contextWindow: Int? = null,
    val percent: Double? = null,
)

@Serializable
data class WsNotificationData(
    val kind: String = "",
    val title: String = "",
    val body: String? = null,
    val slot: String? = null,
    val ts: String? = null,
    val acked: Boolean? = null,
)

// ---------------------------------------------------------------------------
// Decoded frames
// ---------------------------------------------------------------------------

sealed interface WsFrame {
    data class Slots(val slots: List<SlotDto>) : WsFrame
    data class ChatChunk(val slot: String, val content: String) : WsFrame
    data class ChatMessage(val slot: String, val message: MessageDto) : WsFrame
    data class ChatDone(val slot: String) : WsFrame
    data class ChatError(val slot: String, val message: String) : WsFrame
    data class ToolCall(val slot: String, val tool: String, val id: String, val args: String?) : WsFrame
    data class ToolResult(
        val slot: String,
        val tool: String,
        val id: String,
        val result: String?,
        val isError: Boolean?,
    ) : WsFrame

    data class ToolUpdate(val slot: String, val id: String, val partial: String?) : WsFrame
    data class SlotTitle(val key: String, val title: String) : WsFrame
    data class SlotTags(val key: String, val tags: List<String>) : WsFrame
    data class ContextUsage(val slot: String, val tokens: Int?, val percent: Double?) : WsFrame
    data class Notification(val kind: String, val title: String, val body: String?) : WsFrame
    data object Unknown : WsFrame
}

/** Parse one WebSocket text frame; returns null when the frame is malformed. */
fun parseWsFrame(text: String): WsFrame? {
    val root = runCatching { pidashJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
    val type = (root["type"] as? JsonPrimitive)?.contentOrNull ?: return null
    val data: JsonElement = root["data"] ?: JsonNull

    return runCatching {
        when (type) {
            "slots" -> WsFrame.Slots(
                (data as? JsonArray)
                    ?.mapNotNull { el ->
                        runCatching { pidashJson.decodeFromJsonElement(SlotDto.serializer(), el) }.getOrNull()
                    }
                    .orEmpty()
            )

            "chat_chunk" -> {
                val d = pidashJson.decodeFromJsonElement(WsChatChunkData.serializer(), data)
                WsFrame.ChatChunk(d.slot, d.content)
            }

            "chat_message" -> {
                val d = pidashJson.decodeFromJsonElement(WsChatMessageData.serializer(), data)
                WsFrame.ChatMessage(d.slot, MessageDto(d.role, d.content, d.ts, d.meta))
            }
            "chat_done" -> {
                val d = pidashJson.decodeFromJsonElement(WsChatDoneData.serializer(), data)
                WsFrame.ChatDone(d.slot)
            }

            "chat_error" -> {
                val d = pidashJson.decodeFromJsonElement(WsChatErrorData.serializer(), data)
                WsFrame.ChatError(d.slot, d.message)
            }

            "tool_call" -> {
                val d = pidashJson.decodeFromJsonElement(WsToolCallData.serializer(), data)
                WsFrame.ToolCall(d.slot, d.tool, d.id, d.args?.toString())
            }

            "tool_result" -> {
                val d = pidashJson.decodeFromJsonElement(WsToolResultData.serializer(), data)
                WsFrame.ToolResult(d.slot, d.tool, d.id, d.result, d.isError)
            }

            "tool_update" -> {
                val d = pidashJson.decodeFromJsonElement(WsToolUpdateData.serializer(), data)
                WsFrame.ToolUpdate(d.slot, d.id, d.partial)
            }

            "slot_title" -> {
                val d = pidashJson.decodeFromJsonElement(WsSlotTitleData.serializer(), data)
                WsFrame.SlotTitle(d.key, d.title)
            }

            "slot_tags" -> {
                val d = pidashJson.decodeFromJsonElement(WsSlotTagsData.serializer(), data)
                WsFrame.SlotTags(d.key, d.tags)
            }

            "context_usage" -> {
                val d = pidashJson.decodeFromJsonElement(WsContextUsageData.serializer(), data)
                WsFrame.ContextUsage(d.slot, d.tokens, d.percent)
            }

            "notification" -> {
                val d = pidashJson.decodeFromJsonElement(WsNotificationData.serializer(), data)
                WsFrame.Notification(d.kind, d.title, d.body)
            }

            else -> WsFrame.Unknown
        }
    }.getOrNull()
}
