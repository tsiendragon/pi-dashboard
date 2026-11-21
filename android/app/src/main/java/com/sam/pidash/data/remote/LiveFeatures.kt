package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * Extension feature snapshots arrive as `live_feature_snapshot` events whose
 * `data` is `{feature, snapshot}` (see `pi-tsien-live-session`).
 *
 * Projected here: the background-command panel (a foreground bash call can be
 * handed to the background), armed schedules, subagent/workflow activity, and PiMatrix proof jobs.
 * Nothing here issues commands — that stays in the repository under an explicit lease.
 */
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

internal fun featureSnapshot(detail: LiveDetail?, feature: String): JsonObject? {
    val latest = detail?.entries?.asReversed()?.firstNotNullOfOrNull { raw ->
        val entry = raw as? JsonObject ?: return@firstNotNullOfOrNull null
        if (entry.str("type") != "live_feature_snapshot") return@firstNotNullOfOrNull null
        val data = entry["data"] as? JsonObject ?: return@firstNotNullOfOrNull null
        data.takeIf { it.str("feature") == feature }
    }
    // A clear event may omit the snapshot; never revive an older one.
    return latest?.get("snapshot") as? JsonObject
}

fun backgroundSnapshot(detail: LiveDetail?): LiveBackgroundSnapshot? =
    featureSnapshot(detail, "background-commands")?.let(::decodeBackgroundSnapshot)

internal data class LiveScheduleSummary(val count: Int, val nextRunAt: Long)

/** The extension includes only armed schedules; cancellation or a one-shot firing removes it. */
internal fun scheduleSummary(detail: LiveDetail?): LiveScheduleSummary? {
    val tasks = featureSnapshot(detail, "schedule")?.get("tasks") as? JsonArray ?: return null
    val dueTimes = tasks.mapNotNull { raw ->
        val task = raw as? JsonObject ?: return@mapNotNull null
        if (task.str("id").isNullOrBlank()) return@mapNotNull null
        (task["nextRunAt"] as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    }
    val next = dueTimes.minOrNull() ?: return null
    return LiveScheduleSummary(dueTimes.size, next)
}

/**
 * One PiMatrix proof job from the read-only `proof-jobs` feature:
 * `{tasks:[{id,label,state,createdAt?,startedAt?,finishedAt?,collected?}]}`, epoch ms.
 * Unknown states are kept as `unknown` so a newer producer never hides a job.
 */
internal data class LiveProofJob(
    val id: String,
    val label: String,
    val state: String,
    val createdAt: Long? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val collected: Boolean? = null,
) {
    val isActive: Boolean get() = state == "running" || state == "queued"
}

internal data class LiveProofJobs(val jobs: List<LiveProofJob>) {
    val running: Int get() = jobs.count { it.state == "running" }
    val queued: Int get() = jobs.count { it.state == "queued" }
    val active: Int get() = running + queued
}

private val PROOF_JOB_STATES = setOf("queued", "running", "finished", "failed", "cancelled")
private val PROOF_JOB_ORDER = mapOf("running" to 0, "queued" to 1)

/** null until the session publishes the feature (every non-PiMatrix session). */
internal fun proofJobs(detail: LiveDetail?): LiveProofJobs? =
    featureSnapshot(detail, "proof-jobs")?.let(::decodeProofJobs)

internal fun decodeProofJobs(snapshot: JsonObject): LiveProofJobs? {
    val tasks = snapshot["tasks"] as? JsonArray ?: return null
    val seen = HashSet<String>()
    val jobs = tasks.mapNotNull { raw ->
        val task = raw as? JsonObject ?: return@mapNotNull null
        val id = task.str("id")?.trim()?.takeIf { it.isNotEmpty() && seen.add(it) } ?: return@mapNotNull null
        fun time(key: String) = (task[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it > 0 }
        LiveProofJob(
            id = id,
            label = task.str("label")?.trim()?.takeIf { it.isNotEmpty() } ?: id,
            state = task.str("state")?.takeIf { it in PROOF_JOB_STATES } ?: "unknown",
            createdAt = time("createdAt"),
            startedAt = time("startedAt"),
            finishedAt = time("finishedAt"),
            collected = (task["collected"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull,
        )
    }
    val recency = { job: LiveProofJob -> job.finishedAt ?: job.startedAt ?: job.createdAt ?: 0L }
    return LiveProofJobs(jobs.sortedWith(compareBy<LiveProofJob> { PROOF_JOB_ORDER[it.state] ?: 2 }.thenByDescending(recency)))
}

/** Kept next to the projection so the parsing contract is testable alone. */
internal fun decodeBackgroundSnapshot(element: JsonElement): LiveBackgroundSnapshot? = runCatching {
    pidashJson.decodeFromJsonElement(LiveBackgroundSnapshot.serializer(), element.jsonObject)
}.getOrNull()

internal fun LiveBackgroundTask.isActive(): Boolean = status == "running" || status == "starting"

internal fun LiveBackgroundSnapshot.activeBackgroundTasks(): List<LiveBackgroundTask> =
    tasks.filter { it.mode != "foreground" && it.isActive() }

/** A foreground call is the only one the dashboard may hand to the background. */
internal fun LiveBackgroundTask.canMoveToBackground(): Boolean =
    mode == "foreground" && isActive() && !toolCallId.isNullOrBlank()

internal fun LiveBackgroundTask.elapsedSeconds(now: Long): Long {
    val end = endedAt ?: now
    return ((end - startedAt) / 1000).coerceAtLeast(0)
}
