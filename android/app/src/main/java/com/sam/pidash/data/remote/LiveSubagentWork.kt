package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

internal data class LiveWorkCounts(val running: Int, val queued: Int) {
    val active: Int get() = running + queued
}

internal data class LiveSubagentWork(val subagents: LiveWorkCounts, val workflows: LiveWorkCounts) {
    val running: Int get() = subagents.running + workflows.running
    val active: Int get() = subagents.active + workflows.active
}

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.flag(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull == true

private fun JsonObject.items(key: String): List<JsonObject>? =
    ((this[key] as? JsonObject)?.get("items") as? JsonArray)?.filterIsInstance<JsonObject>()

private fun Iterable<String?>.workCounts(): LiveWorkCounts {
    var running = 0
    var queued = 0
    for (status in this) {
        when (status?.trim()?.lowercase()) {
            "running", "in_progress", "active", "starting", "busy" -> running++
            "queued", "pending" -> queued++
        }
    }
    return LiveWorkCounts(running, queued)
}

/** Same wire records and top-level conversation rules as Web's subagent projection. */
internal fun subagentWork(detail: LiveDetail?): LiveSubagentWork? {
    val snapshot = featureSnapshot(detail, "subagent-workflow") ?: return null
    val conversations = snapshot.items("conversations")
    val workflows = snapshot.items("workflows")
    if (conversations == null && workflows == null) return null
    val subagentCounts = conversations.orEmpty().filterNot { item ->
        // The workflow already represents these children; counting both inflates the badge.
        listOf("workflowId", "parentWorkflowId", "workflowTaskId").any { !item.text(it).isNullOrBlank() }
    }.map { item ->
        when {
            !item.text("activeRunId").isNullOrEmpty() -> "running"
            item.flag("needsAttention") || item.flag("stalled") -> "blocked"
            else -> item.text("latestRunStatus").takeUnless { it.isNullOrEmpty() } ?: item.text("status")
        }
    }.workCounts()
    return LiveSubagentWork(subagentCounts, workflows.orEmpty().map { it.text("status") }.workCounts())
}
