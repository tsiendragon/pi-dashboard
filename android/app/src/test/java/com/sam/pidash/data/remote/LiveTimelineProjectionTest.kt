package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A tool call is one collapsed line — never JSON dumped into the reply body. */
class LiveTimelineProjectionTest {
    private val detail = LiveDetail(LiveSummary(processInstanceId = "p", sessionId = "s", cwd = "/w"))

    private fun project(vararg entries: String) = projectLiveTimeline(
        detail.copy(entries = entries.map { Json.parseToJsonElement(it) as JsonElement })
    )

    @Test fun aToolCallBecomesOneLineAndTheResultCompletesIt() {
        val items = project(
            """{"type":"message","id":"m1","message":{"role":"assistant","content":[
                 {"type":"text","text":"先看目录"},
                 {"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"ls -la"}}]}}""",
            """{"type":"message","id":"m2","message":{"role":"toolResult","toolCallId":"call-1","toolName":"bash",
                 "content":[{"type":"text","text":"a.txt\nb.txt"}]}}""",
        )
        assertEquals(2, items.size)
        assertEquals("先看目录", items[0].text)
        assertFalse("the arguments must not leak into the prose", items[0].text.contains("ls -la"))
        val tool = items[1]
        assertEquals("tool", tool.role)
        assertEquals("bash", tool.toolName)
        assertEquals("call-1", tool.toolCallId)
        assertTrue(tool.toolArgs.orEmpty().contains("ls -la"))
        assertEquals("a.txt\nb.txt", tool.text)
        assertEquals("done", tool.status)
    }

    @Test fun aToolOnlyMessageLeavesNoEmptyProseCard() {
        val items = project(
            """{"type":"message","id":"m1","message":{"role":"assistant","content":[
                 {"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"/repo/a.ts"}}]}}""",
        )
        assertEquals(1, items.size)
        assertEquals("tool", items.single().role)
        assertEquals("read", items.single().toolName)
    }

    @Test fun executionEventsAndThePersistedResultStayOneLine() {
        val items = project(
            """{"type":"message","id":"m1","message":{"role":"assistant","content":[
                 {"type":"toolCall","id":"call-9","name":"bash","arguments":{"command":"npm test"}}]}}""",
            """{"type":"tool_execution_start","data":{"toolCallId":"call-9","toolName":"bash","args":{"command":"npm test"}}}""",
            """{"type":"tool_execution_end","data":{"toolCallId":"call-9","toolName":"bash","isError":false,
                 "result":{"content":[{"type":"text","text":"ok"}]}}}""",
        )
        assertEquals(1, items.size)
        assertEquals("ok", items.single().text)
        assertEquals("done", items.single().status)
        assertTrue(items.single().toolArgs.orEmpty().contains("npm test"))
    }

    @Test fun aFailedToolKeepsItsErrorStatus() {
        val items = project(
            """{"type":"message","id":"m1","message":{"role":"toolResult","toolCallId":"call-2","toolName":"bash","isError":true,
                 "content":[{"type":"text","text":"boom"}]}}""",
        )
        assertTrue(items.single().isError)
        assertEquals("error", items.single().status)
    }

    @Test fun imagesAreInlinePartsNotPlaceholderText() {
        val items = project(
            """{"type":"message","id":"m1","message":{"role":"user","content":[
                 {"type":"text","text":"看这个"},
                 {"type":"image","mimeType":"image/png","data":"AAAA"}]}}""",
        )
        assertEquals("看这个", items.single().text)
        assertEquals(1, items.single().images.size)
        assertTrue(items.single().forkable)
    }

    @Test fun runCodeKeepsItsArgumentsForTheRunCodeLabel() {
        val items = project(
            """{"type":"message","id":"m1","message":{"role":"assistant","content":[
                 {"type":"toolCall","id":"call-3","name":"run_code","arguments":{"code":"print(1)"}}]}}""",
        )
        assertEquals("run_code", items.single().toolName)
        assertTrue(items.single().toolArgs.orEmpty().contains("print(1)"))
    }

    @Test fun repeatedStreamingUpdatesReplaceInsteadOfDuplicating() {
        val items = project(
            """{"type":"message_update","data":{"entryId":"e1","message":{"role":"assistant","content":[{"type":"text","text":"a"}]}}}""",
            """{"type":"message_update","data":{"entryId":"e1","message":{"role":"assistant","content":[{"type":"text","text":"ab"}]}}}""",
        )
        assertEquals(1, items.size)
        assertEquals("ab", items.single().text)
        assertEquals("running", items.single().status)
    }
}
