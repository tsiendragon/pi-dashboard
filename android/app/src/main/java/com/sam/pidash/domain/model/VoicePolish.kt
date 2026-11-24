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
