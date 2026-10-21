package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveTimelineItem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Payload handed to the bundled WebUI renderer.
 *
 * Pure Kotlin (no Android types) so the contract can be unit tested: the renderer
 * only ever receives already-projected items — it never fetches anything itself,
 * which is what keeps the WebView credential-free.
 */
internal fun transcriptPayload(items: List<LiveTimelineItem>, dark: Boolean, emptyText: String): String =
    buildJsonObject {
        put("theme", if (dark) "dark" else "light")
        put("emptyText", emptyText)
        put("items", JsonArray(items.map { item ->
            buildJsonObject {
                put("id", item.id)
                put("role", item.role)
                put("text", item.text)
                put("status", item.status)
                if (item.thinking != null) put("thinking", item.thinking)
                if (item.toolName != null) put("toolName", item.toolName)
                if (item.isError) put("isError", true)
            }
        }))
    }.toString()