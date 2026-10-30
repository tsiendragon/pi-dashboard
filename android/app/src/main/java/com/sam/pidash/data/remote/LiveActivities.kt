package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.*
import kotlinx.serialization.json.decodeFromJsonElement

private fun flatText(value: String): String = value.replace(Regex("\\s+"), " ").trim()

private fun hasSettledReply(items: List<LiveTimelineItem>): Boolean {
    val lastUser = items.indexOfLast { it.role == "user" }
    val tail = if (lastUser >= 0) items.subList(lastUser + 1, items.size) else items
    return tail.any {
        it.role == "assistant" && it.status == "done" && !it.intermediate &&
            (it.channel == null || it.channel == "final") && it.text.isNotBlank() && !it.isError
    }
}

private fun quoteOwner(buckets: List<MutableList<LiveTimelineItem>>, text: String): MutableList<LiveTimelineItem>? {
    for (snippet in quotedSnippets(text)) {
        val needle = flatText(snippet).removeSuffix("…")
        if (needle.length < 8) continue
        for (bucket in buckets.asReversed()) {
            if (bucket.any { it.role != "tool" && it.toolCallId == null && flatText(it.text).contains(needle) }) {
                return bucket
            }
        }
    }
    return null
}

/** Mobile activity projection with quote/comment follow-up attribution matching the WebUI. */
fun projectLiveActivities(detail: LiveDetail): List<LiveActivity> {
    val buckets = mutableListOf<MutableList<LiveTimelineItem>>()
    var current: MutableList<LiveTimelineItem>? = null
    projectLiveTimeline(detail).forEach { item ->
        if (item.role == "user") {
            val followUp = quoteOrCommentKind(item.text) != null
            val active = current
            if (followUp && active != null) {
                val target = (if (!hasSettledReply(active)) active else quoteOwner(buckets, item.text)) ?: active
                target.add(item)
                current = target
            } else {
                val started = mutableListOf(item)
                buckets.add(started)
                current = started
            }
        } else {
            val target = current ?: mutableListOf<LiveTimelineItem>().also {
                buckets.add(it)
                current = it
            }
            target.add(item)
        }
    }
    return buckets.map { items ->
        val active = items === current
        val finalReply = hasSettledReply(items)
        val state = when {
            active && detail.summary.status == "reconnecting" -> "重连中"
            active && detail.summary.status == "running" -> "工作中"
            items.any { it.isError } -> "有失败，需检查"
            items.any { it.role == "tool" && it.status == "running" } -> "执行状态待确认"
            finalReply -> "已回复"
            else -> "待确认"
        }
        LiveActivity(items.first().id, items.firstOrNull { it.role == "user" }?.text ?: "已有活动（窗口内记录）", state, items.toList())
    }
}

/**
 * The replies the activity view shows: assistant text that is not an intermediate
 * step and not an error. Falls back to the last assistant text so a turn that ended
 * mid-flight still shows something instead of an empty card.
 */
fun activityReplies(activity: LiveActivity): List<LiveTimelineItem> {
    val final = activity.items.filter {
        it.role == "assistant" && it.text.isNotBlank() && !it.isError && !it.intermediate
    }
    if (final.isNotEmpty()) return final
    return listOfNotNull(activity.items.lastOrNull { it.role == "assistant" && it.text.isNotBlank() })
}

/** Tools that belong to this turn, in order; used for the one-line step summary. */
fun activityTools(activity: LiveActivity): List<LiveTimelineItem> =
    activity.items.filter { it.role == "tool" || it.role == "toolResult" || it.toolCallId != null }

/** The compact card follows record order; omitted middle items remain available in detail. */
fun activityOverview(activity: LiveActivity, limit: Int = 5): List<LiveTimelineItem?> {
    val firstUser = activity.items.firstOrNull { it.role == "user" }
    val entries = activity.items.filter { item ->
        item.role == "tool" || item.role == "toolResult" || item.toolCallId != null ||
            (item.role == "assistant" && item.text.isNotBlank()) ||
            (item.role == "user" && item !== firstUser && item.text.isNotBlank())
    }
    if (entries.size <= limit || limit < 2) return entries.take(limit.coerceAtLeast(0))
    return entries.take(limit - 1) + listOf(null) + entries.takeLast(1)
}

fun liveGoalAnchor(detail: LiveDetail): LiveGoalAnchor? = detail.goal?.let {
    runCatching { pidashJson.decodeFromJsonElement<LiveGoalAnchor>(it) }.getOrNull()
}
