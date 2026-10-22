package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Extension feature snapshots arrive as `live_feature_snapshot` events whose
 * `data` is `{feature, snapshot}` (see `pi-tsien-live-session`).
 *
 * Only the background-command panel is projected for now: a foreground bash call
 * can be handed to the background, and its output tail is shown. Nothing here
 * issues commands — that stays in the repository under an explicit lease.
 */
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

fun backgroundSnapshot(detail: LiveDetail?): LiveBackgroundSnapshot? {
    if (detail == null) return null
    var latest: JsonObject? = null
    detail.entries.forEach { raw ->
        val entry = raw as? JsonObject ?: return@forEach
        if (entry.str("type") != "live_feature_snapshot") return@forEach
        val data = entry["data"] as? JsonObject ?: return@forEach
        if (data.str("feature") != "background-commands") return@forEach
        latest = (data["snapshot"] as? JsonObject) ?: return@forEach
    }
    val snapshot = latest ?: return null
    return runCatching { pidashJson.decodeFromJsonElement(LiveBackgroundSnapshot.serializer(), snapshot) }.getOrNull()
}

/** Kept next to the projection so the parsing contract is testable alone. */
internal fun decodeBackgroundSnapshot(element: JsonElement): LiveBackgroundSnapshot? = runCatching {
    pidashJson.decodeFromJsonElement(LiveBackgroundSnapshot.serializer(), element.jsonObject)
}.getOrNull()

internal fun LiveBackgroundTask.isActive(): Boolean = status == "running" || status == "starting"

/** A foreground call is the only one the dashboard may hand to the background. */
internal fun LiveBackgroundTask.canMoveToBackground(): Boolean =
    mode == "foreground" && isActive() && !toolCallId.isNullOrBlank()

internal fun LiveBackgroundTask.elapsedSeconds(now: Long): Long {
    val end = endedAt ?: now
    return ((end - startedAt) / 1000).coerceAtLeast(0)
}
