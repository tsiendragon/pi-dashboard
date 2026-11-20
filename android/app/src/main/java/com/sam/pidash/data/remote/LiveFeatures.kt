package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * Extension feature snapshots arrive as `live_feature_snapshot` events whose
 * `data` is `{feature, snapshot}` (see `pi-tsien-live-session`).
 *
 * Only the background-command panel is projected for now: a foreground bash call
 * can be handed to the background, and its output tail is shown. Nothing here
 * issues commands — that stays in the repository under an explicit lease.
 */
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun featureSnapshot(detail: LiveDetail?, feature: String): JsonObject? {
    return detail?.entries?.asReversed()?.firstNotNullOfOrNull { raw ->
        val entry = raw as? JsonObject ?: return@firstNotNullOfOrNull null
        if (entry.str("type") != "live_feature_snapshot") return@firstNotNullOfOrNull null
        val data = entry["data"] as? JsonObject ?: return@firstNotNullOfOrNull null
        data.takeIf { it.str("feature") == feature }?.get("snapshot") as? JsonObject
    }
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
