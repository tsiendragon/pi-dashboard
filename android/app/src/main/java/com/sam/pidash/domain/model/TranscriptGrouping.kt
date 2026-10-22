package com.sam.pidash.domain.model

/**
 * Transcript rows as the reader should see them.
 *
 * A run of consecutive tool calls is one collapsible group (the WebUI folds the
 * same runs into a single activity block); everything else stays on its own.
 */
sealed interface TranscriptRow {
    val id: String

    data class Single(val item: LiveTimelineItem) : TranscriptRow {
        override val id: String get() = "row:${item.id}"
    }

    data class Steps(val items: List<LiveTimelineItem>) : TranscriptRow {
        override val id: String get() = "steps:${items.first().id}"
        val failed: Boolean get() = items.any { it.isError }
        val running: Boolean get() = items.any { it.status == "running" }
        val names: List<String> get() = items.mapNotNull { it.toolName }.distinct()
    }
}

private fun isTool(item: LiveTimelineItem) =
    item.role == "tool" || item.role == "toolResult" || item.toolCallId != null

fun groupTranscript(items: List<LiveTimelineItem>, minRun: Int = 2): List<TranscriptRow> {
    val rows = mutableListOf<TranscriptRow>()
    var run = mutableListOf<LiveTimelineItem>()
    fun flush() {
        when {
            run.isEmpty() -> Unit
            run.size >= minRun -> rows += TranscriptRow.Steps(run.toList())
            else -> run.forEach { rows += TranscriptRow.Single(it) }
        }
        run = mutableListOf()
    }
    items.forEach { item ->
        if (isTool(item)) run += item else { flush(); rows += TranscriptRow.Single(item) }
    }
    flush()
    return rows
}
