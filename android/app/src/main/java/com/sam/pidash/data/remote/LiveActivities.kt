package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.*
import kotlinx.serialization.json.decodeFromJsonElement

/** A conservative mobile projection, not the WebUI's full quote/workflow phase inference. */
fun projectLiveActivities(detail: LiveDetail): List<LiveActivity> {
    val buckets = mutableListOf<MutableList<LiveTimelineItem>>()
    projectLiveTimeline(detail).forEach { item ->
        if (item.role == "user" || buckets.isEmpty()) buckets.add(mutableListOf())
        buckets.last().add(item)
    }
    return buckets.mapIndexed { index, items ->
        val current = index == buckets.lastIndex
        val finalReply = items.any { it.role == "assistant" && it.status == "done" && !it.intermediate &&
            (it.channel == null || it.channel == "final") && it.text.isNotBlank() && !it.isError }
        val state = when {
            current && detail.summary.status == "reconnecting" -> "重连中"
            current && detail.summary.status == "running" -> "工作中"
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
    activity.items.filter { it.role == "tool" || it.toolCallId != null }

fun liveGoalAnchor(detail: LiveDetail): LiveGoalAnchor? = detail.goal?.let {
    runCatching { pidashJson.decodeFromJsonElement<LiveGoalAnchor>(it) }.getOrNull()
}
