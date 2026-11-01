package com.sam.pidash.ui.live

private const val PREVIEW_LINES = 12
private const val PREVIEW_CHARS = 1200

internal data class TranscriptPreview(val visible: String, val long: Boolean, val lineCount: Int)

internal fun transcriptPreview(text: String, expanded: Boolean): TranscriptPreview {
    val lines = text.split('\n')
    val long = lines.size > PREVIEW_LINES || text.length > PREVIEW_CHARS
    val visible = if (long && !expanded) lines.take(PREVIEW_LINES).joinToString("\n").take(PREVIEW_CHARS) else text
    return TranscriptPreview(visible, long, lines.size)
}
