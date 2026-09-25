package com.sam.pidash.domain.model

import kotlinx.serialization.Serializable

/** One pi-dashboard server the app talks to. Persisted in DataStore as JSON. */
@Serializable
data class Backend(
    val id: String,
    val name: String,
    val baseUrl: String,
    /**
     * Optional Authorization credential applied to every request (REST + WebSocket).
     * Empty = no auth header. A bare value is sent as `Bearer <value>`; a value that
     * already starts with `Bearer ` / `Basic ` is sent verbatim (edge/nginx auth).
     */
    val token: String = "",
)

/** Identifies a chat slot on a specific backend. */
data class SessionKey(val backendId: String, val slotKey: String)

/** A chat slot (conversation) on one backend. */
data class ChatSlot(
    val key: String,
    val title: String,
    val messageCount: Int,
    val running: Boolean,
    val pendingApproval: Boolean,
    val model: String?,
    val cwd: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val tags: List<String>,
)

enum class MessageRole { USER, ASSISTANT, SYSTEM, TOOL, OTHER }

/** Extra data attached to a message (thinking text, tool call info, token counts). */
data class MessageMeta(
    val thinking: String? = null,
    val model: String? = null,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val toolName: String? = null,
    val toolCallId: String? = null,
    val args: String? = null,
    val result: String? = null,
    val isError: Boolean? = null,
)

data class ChatMessage(
    val role: MessageRole,
    val content: String,
    val timestamp: Long,
    val meta: MessageMeta? = null,
    /** True for a locally appended (optimistic) message not yet confirmed by the server. */
    val local: Boolean = false,
)

/** A chat slot merged across backends, tagged with its origin. */
data class AggregatedSlot(
    val key: SessionKey,
    val backendName: String,
    val slot: ChatSlot,
)

enum class ConnectionState { Disconnected, Connecting, Connected, Error }

fun roleOf(raw: String?): MessageRole = when (raw) {
    "user" -> MessageRole.USER
    "assistant" -> MessageRole.ASSISTANT
    "system" -> MessageRole.SYSTEM
    "tool" -> MessageRole.TOOL
    else -> MessageRole.OTHER
}
