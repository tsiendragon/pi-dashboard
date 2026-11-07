package com.sam.pidash.domain.model

/** A presentation row; [precedingThinking] still precedes [item] in the original transcript. */
internal data class DetailTraceEntry(val item: LiveTimelineItem, val precedingThinking: List<LiveTimelineItem> = emptyList())

/** Fold only adjacent pure thinking into the following tool. Never cross a message boundary. */
internal fun detailTraceEntries(items: List<LiveTimelineItem>): List<DetailTraceEntry> = buildList {
    val pending = mutableListOf<LiveTimelineItem>()
    fun flush() { pending.forEach { add(DetailTraceEntry(it)) }; pending.clear() }
    items.forEach { item ->
        when {
            isDetailThinking(item) -> pending += item
            isDetailTool(item) -> { add(DetailTraceEntry(item, pending.toList())); pending.clear() }
            else -> { flush(); add(DetailTraceEntry(item)) }
        }
    }
    flush()
}
