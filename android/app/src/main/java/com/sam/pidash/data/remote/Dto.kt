package com.sam.pidash.data.remote

import com.sam.pidash.core.nowMillis
import com.sam.pidash.core.parseIso
import com.sam.pidash.core.timestampFromKey
import com.sam.pidash.domain.model.ChatMessage
import com.sam.pidash.domain.model.ChatSlot
import com.sam.pidash.domain.model.MessageMeta
import com.sam.pidash.domain.model.roleOf
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ---------------------------------------------------------------------------
// REST models — mirrors apple/PiDash Models/APIModels.swift
// ---------------------------------------------------------------------------

/** Element of `GET /api/chat/slots`. */
@Serializable
data class SlotDto(
    val key: String,
    val title: String? = null,
    val messages: Int? = null,
    val running: Boolean? = null,
    val stopping: Boolean? = null,
    @SerialName("pending_approval") val pendingApproval: Boolean? = null,
    val model: String? = null,
    val cwd: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val tags: List<String>? = null,
) {
    fun toModel(): ChatSlot {
        val created = parseIso(createdAt) ?: timestampFromKey(key)
        return ChatSlot(
            key = key,
            title = title?.takeIf { it.isNotBlank() } ?: "New Chat",
            messageCount = messages ?: 0,
            running = running ?: false,
            pendingApproval = pendingApproval ?: false,
            model = model,
            cwd = cwd,
            createdAt = created,
            updatedAt = parseIso(updatedAt) ?: created,
            tags = tags ?: emptyList(),
        )
    }
}

/** `GET /api/chat/slots/:key`. */
@Serializable
data class SlotDetailDto(
    val messages: List<MessageDto> = emptyList(),
    val running: Boolean? = null,
    val stopping: Boolean? = null,
    @SerialName("pending_approval") val pendingApproval: Boolean? = null,
    @SerialName("has_more") val hasMore: Boolean? = null,
    val total: Int? = null,
    val model: String? = null,
    val cwd: String? = null,
    val thinkingLevel: String? = null,
)

@Serializable
data class MessageDto(
    val role: String? = null,
    val content: String? = null,
    val ts: String? = null,
    val meta: MessageMetaDto? = null,
) {
    fun toModel(): ChatMessage = ChatMessage(
        role = roleOf(role),
        content = content.orEmpty(),
        timestamp = parseIso(ts) ?: nowMillis(),
        meta = meta?.toModel(),
    )
}

@Serializable
data class MessageMetaDto(
    val thinking: String? = null,
    val model: String? = null,
    @SerialName("input_tokens") val inputTokens: Int? = null,
    @SerialName("output_tokens") val outputTokens: Int? = null,
    @SerialName("toolName") val toolName: String? = null,
    @SerialName("toolCallId") val toolCallId: String? = null,
    val args: String? = null,
    val result: String? = null,
    @SerialName("isError") val isError: Boolean? = null,
) {
    fun toModel(): MessageMeta = MessageMeta(
        thinking = thinking,
        model = model,
        inputTokens = inputTokens,
        outputTokens = outputTokens,
        toolName = toolName,
        toolCallId = toolCallId,
        args = args,
        result = result,
        isError = isError,
    )
}

/** `GET /api/status`. */
@Serializable
data class StatusDto(
    val version: String? = null,
    val status: String? = null,
)

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

@Serializable
data class CreateSlotRequest(
    val name: String? = null,
    val cwd: String? = null,
    val model: String? = null,
)

@Serializable
data class SendMessageRequest(
    val slot: String,
    val message: String,
)

@Serializable
data class RenameSlotRequest(val title: String)

@Serializable
data class SetCwdRequest(val cwd: String)
