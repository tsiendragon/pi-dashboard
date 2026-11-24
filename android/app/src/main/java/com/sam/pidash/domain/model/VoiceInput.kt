package com.sam.pidash.domain.model

import kotlinx.serialization.Serializable

/** Availability advertised by the dashboard; the API key stays on the server. */
@Serializable
data class AsrConfig(
    val available: Boolean = false,
    val reason: String? = null,
    val defaultModel: String = "",
    val maxAudioBytes: Long = 0,
    /** Older servers omit this; the app still tries polish and falls back to raw on failure. */
    val polishAvailable: Boolean? = null,
    val polishModel: String? = null,
)

/** Optional, deliberately tiny context for post-ASR cleanup. */
@Serializable
data class VoicePolishContext(
    val title: String? = null,
    val cwd: String? = null,
    val draft: String? = null,
    val recent: List<VoicePolishMessage> = emptyList(),
)

@Serializable
data class VoicePolishMessage(val role: String, val text: String)

@Serializable
data class VoicePolishResult(
    val text: String,
    val polished: Boolean = false,
    val model: String? = null,
)

/**
 * The composer's voice state. Audio is never persisted by the app: it exists only while
 * [Listening] and the in-memory socket/recorder are released on stop, error or screen exit.
 */
enum class VoiceInputPhase {
    Idle,
    Connecting,
    Listening,
    Transcribing,
}

data class VoiceInputState(
    val phase: VoiceInputPhase = VoiceInputPhase.Idle,
    /** Provisional words from the provider; final text is appended through the callback. */
    val interim: String = "",
    val error: String? = null,
)

/** Append a completed speech segment without replacing or gluing onto the user's draft. */
fun appendVoiceTranscript(current: String, transcript: String): String {
    val text = transcript.trim()
    if (text.isEmpty()) return current
    if (current.isBlank()) return current + text
    return current + (if (current.last().isWhitespace()) "" else " ") + text
}