package com.sam.pidash.domain.model

/** Presentation-only grouping for the detail page; original items and order are retained. */
internal sealed interface ActivityDetailRow {
    val id: String

    data class Message(val item: LiveTimelineItem) : ActivityDetailRow {
        override val id: String get() = "message:${item.id}"
    }

    data class Trace(val items: List<LiveTimelineItem>) : ActivityDetailRow {
        override val id: String get() = "trace:${items.first().id}"
        val toolCount: Int get() = items.count(::isDetailTool)
        val thinkingCount: Int get() = items.count(::isDetailThinking)
        val failedCount: Int get() = items.count { it.isError || it.status == "error" }
        val runningCount: Int get() = items.count { !it.isError && it.status == "running" }
        val unknownCount: Int get() = items.count { !it.isError && it.status !in setOf("done", "running", "error") }
    }
}

internal fun isDetailTool(item: LiveTimelineItem): Boolean =
    item.role == "tool" || item.role == "toolResult" || item.toolCallId != null

internal fun isDetailThinking(item: LiveTimelineItem): Boolean =
    !isDetailTool(item) && item.role == "assistant" && item.text.isBlank() &&
        !item.thinking.isNullOrBlank() && item.images.isEmpty() && !item.isError && !item.forkable

internal fun groupActivityDetail(items: List<LiveTimelineItem>): List<ActivityDetailRow> {
    val rows = mutableListOf<ActivityDetailRow>()
    val trace = mutableListOf<LiveTimelineItem>()
    fun flush() {
        if (trace.isNotEmpty()) {
            rows += ActivityDetailRow.Trace(trace.toList())
            trace.clear()
        }
    }
    items.forEach { item ->
        if (isDetailTool(item) || isDetailThinking(item)) trace += item
        else {
            flush()
            rows += ActivityDetailRow.Message(item)
        }
    }
    flush()
    return rows
}
