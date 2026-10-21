package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveTimelineItem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The WebView renderer contract: projected items only, no credentials, no fetches. */
class TranscriptPayloadTest {
    private fun item(id: String, role: String, text: String, status: String = "done") =
        LiveTimelineItem(id, role, text, status = status)

    @Test fun itemsKeepRoleTextAndOrder() {
        val payload = Json.parseToJsonElement(
            transcriptPayload(listOf(item("a", "user", "你好"), item("b", "assistant", "** Markdown **")), true, "空"),
        ).jsonObject
        val items = payload.getValue("items").jsonArray
        assertEquals(2, items.size)
        assertEquals("user", items[0].jsonObject.getValue("role").jsonPrimitive.content)
        assertEquals("** Markdown **", items[1].jsonObject.getValue("text").jsonPrimitive.content)
        assertEquals("空", payload.getValue("emptyText").jsonPrimitive.content)
    }

    @Test fun themeFollowsTheDeviceInsteadOfBeingHardCoded() {
        assertTrue(transcriptPayload(emptyList(), true, "").contains("\"theme\":\"dark\""))
        assertTrue(transcriptPayload(emptyList(), false, "").contains("\"theme\":\"light\""))
    }

    @Test fun toolThinkingAndErrorFlagsAreCarriedButNeverInjected() {
        val tool = LiveTimelineItem("t", "tool", "output", toolName = "read", isError = true,
            thinking = "reasoning", status = "error")
        val entry = Json.parseToJsonElement(transcriptPayload(listOf(tool), true, "")).jsonObject
            .getValue("items").jsonArray.single().jsonObject
        assertEquals("read", entry.getValue("toolName").jsonPrimitive.content)
        assertEquals("reasoning", entry.getValue("thinking").jsonPrimitive.content)
        assertEquals("true", entry.getValue("isError").jsonPrimitive.content)
        assertEquals("error", entry.getValue("status").jsonPrimitive.content)
    }

    @Test fun payloadContainsOnlyKnownKeysAndNoSecrets() {
        val payload = transcriptPayload(listOf(item("a", "user", "text")), true, "")
        val entry = Json.parseToJsonElement(payload).jsonObject.getValue("items").jsonArray.single().jsonObject
        assertTrue(entry.keys.all { it in setOf("id", "role", "text", "status", "thinking", "toolName", "isError") })
        assertFalse(entry.containsKey("leaseId"))
        assertFalse(payload.contains("pi_live_session"))
        assertFalse(payload.contains("Authorization"))
    }

    @Test fun emptyTranscriptIsStillAValidPayload() {
        val payload = transcriptPayload(emptyList(), true, "").let(Json::parseToJsonElement).jsonObject
        assertTrue(payload.getValue("items").jsonArray.isEmpty())
    }
}