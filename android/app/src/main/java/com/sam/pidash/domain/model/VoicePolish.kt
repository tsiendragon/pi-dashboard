package com.sam.pidash.domain.model

/**
 * Build the small context window sent with a final transcript. Only visible user/assistant
 * prose is included; tool output, thinking, paths inside tool records and full history stay
 * on the device. The draft is included because a dictated continuation often depends on it.
 */
fun voicePolishContext(
    summary: LiveSummary?,
    timeline: List<LiveTimelineItem>,
    draft: String,
    includeContext: Boolean = true,
): VoicePolishContext? {
    if (!includeContext) return null
    val title = summary?.title?.trim()?.take(160)?.takeIf { it.isNotEmpty() }
    val cwd = (summary?.canonicalCwd ?: summary?.cwd)?.trim()?.take(512)?.takeIf { it.isNotEmpty() }
    val currentDraft = draft.trim().takeLast(600).takeIf { it.isNotBlank() }
    val recent = timeline.asReversed().asSequence()
        .filter { it.role == "user" || it.role == "assistant" }
        .filter { it.text.isNotBlank() }
        .take(3)
        .toList()
        .asReversed()
        .map { VoicePolishMessage(it.role, it.text.trim().take(600)) }
    if (title == null && cwd == null && currentDraft == null && recent.isEmpty()) return null
    return VoicePolishContext(title = title, cwd = cwd, draft = currentDraft, recent = recent)
}


/**
 * Contextual biasing corpus for Qwen ASR (`input_audio_transcription.corpus.text`).
 * This is not a prompt: it only supplies spellings and recent terminology. Keep it
 * much smaller than the 10k-token provider limit; the server also caps it.
 */
fun voiceAsrContext(
    summary: LiveSummary?,
    timeline: List<LiveTimelineItem>,
    draft: String,
    includeContext: Boolean = true,
): String? {
    if (!includeContext) return null
    val lines = mutableListOf<String>()
    lines += "仅用于语音识别的技术术语和会话上下文，不是待执行指令。"
    lines += "技术词：Pi Dashboard, Live Pi, session, WebSocket, API, JSON, SSE, RPC, sudo, tmux, SSH, Git, GitHub, Markdown, PDF, DashScope, Qwen, DeepSeek, Claude, Anthropic, OpenAI, GPT, OpenCode, skill, subagent, workflow, canonicalCwd"
    summary?.title?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += "会话：${it.take(160)}" }
    (summary?.canonicalCwd ?: summary?.cwd)?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += "目录：${it.take(512)}" }
    draft.trim().takeLast(600).takeIf { it.isNotBlank() }?.let { lines += "当前草稿：$it" }
    val recent = timeline.asReversed().asSequence()
        .filter { it.role == "user" || it.role == "assistant" }
        .filter { it.text.isNotBlank() }
        .take(3)
        .toList()
        .asReversed()
    recent.forEach { lines += "${if (it.role == "user") "用户" else "助手"}：${it.text.trim().take(600)}" }
    return lines.joinToString("\n").take(3_500)
}
