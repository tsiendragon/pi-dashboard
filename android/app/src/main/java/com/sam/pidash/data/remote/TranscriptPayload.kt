package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveTimelineItem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Payload handed to the bundled WebUI renderer.
 *
 * Pure Kotlin (no Android types) so the contract can be unit tested: the renderer
 * only ever receives already-projected items — it never fetches anything itself,
 * which is what keeps the WebView credential-free.
 *
 * Image attachments are real base64 parts, bounded so one long session with many
 * screenshots cannot freeze the WebView.
 */
private const val MAX_PAYLOAD_IMAGE_BYTES = 1_500_000
private const val MAX_PAYLOAD_IMAGES = 12

internal fun transcriptPayload(items: List<LiveTimelineItem>, dark: Boolean, emptyText: String): String {
    var imageBudget = MAX_PAYLOAD_IMAGES
    val encoded = items.map { item ->
        val keep = item.images.take(4).filter { it.data.length * 3 / 4 <= MAX_PAYLOAD_IMAGE_BYTES }.take(imageBudget)
        imageBudget -= keep.size
        buildJsonObject {
            put("id", item.id)
            put("role", item.role)
            put("text", item.text)
            put("status", item.status)
            if (item.thinking != null) put("thinking", item.thinking)
            if (item.toolName != null) put("toolName", item.toolName)
            if (item.isError) put("isError", true)
            if (keep.isNotEmpty()) put("images", buildJsonArray {
                keep.forEach { image ->
                    add(buildJsonObject {
                        put("mimeType", image.mimeType)
                        put("data", image.data)
                    })
                }
            })
        }
    }
    val payload: JsonObject = buildJsonObject {
        put("theme", if (dark) "dark" else "light")
        put("emptyText", emptyText)
        put("items", JsonArray(encoded))
    }
    return payload.toString()
}