package com.sam.pidash.domain.model

import org.junit.Assert.*
import org.junit.Test

class ActivityDetailGroupingTest {
    private fun user(id: String) = LiveTimelineItem(id, "user", "用户消息")
    private fun thought(id: String, status: String = "done") = LiveTimelineItem(id, "assistant", "", thinking = "思考内容", status = status)
    private fun tool(id: String, status: String = "done", error: Boolean = false) =
        LiveTimelineItem(id, "tool", "工具输出", toolName = "bash", toolCallId = id, status = status, isError = error)
    private fun reply(id: String) = LiveTimelineItem(id, "assistant", "正文", thinking = "附带思考")

    @Test fun mixedThoughtsAndToolsAreGroupedWithoutReorderingOrLosingItems() {
        val input = listOf(user("u"), reply("a"), thought("t1"), tool("c1"), thought("t2"), tool("c2"), reply("b"))
        val rows = groupActivityDetail(input)
        assertEquals(4, rows.size)
        val trace = rows[2] as ActivityDetailRow.Trace
        assertEquals(listOf("t1", "c1", "t2", "c2"), trace.items.map { it.id })
        assertEquals(2, trace.toolCount)
        assertEquals(2, trace.thinkingCount)
        assertEquals(input, rows.flatMap { when (it) {
            is ActivityDetailRow.Message -> listOf(it.item)
            is ActivityDetailRow.Trace -> it.items
        } })
    }

    @Test fun normalMessagesImagesAndErrorsBreakTraceAndStayVisible() {
        val error = LiveTimelineItem("e", "assistant", "", thinking = "诊断", isError = true)
        val image = LiveTimelineItem("i", "assistant", "", thinking = "说明", images = listOf(LiveImage("image/png", "fixture")))
        val rows = groupActivityDetail(listOf(thought("a"), error, tool("b"), image, user("u")))
        assertEquals(5, rows.size)
        assertTrue(rows[1] is ActivityDetailRow.Message)
        assertEquals(error, (rows[1] as ActivityDetailRow.Message).item)
        assertEquals(image, (rows[3] as ActivityDetailRow.Message).item)
        assertTrue(rows[4] is ActivityDetailRow.Message)
    }

    @Test fun failureRunningAndUnknownAreReportedWithoutInventingSuccess() {
        val trace = groupActivityDetail(listOf(tool("a", error = true), thought("b", "running"), tool("c", "unknown"))).single() as ActivityDetailRow.Trace
        assertEquals(1, trace.failedCount)
        assertEquals(1, trace.runningCount)
        assertEquals(1, trace.unknownCount)
    }

    @Test fun keyStaysStableAsLiveTraceGrows() {
        val first = groupActivityDetail(listOf(thought("t"))).single().id
        val later = groupActivityDetail(listOf(thought("t"), tool("c"))).single().id
        assertEquals(first, later)
        assertTrue(groupActivityDetail(emptyList()).isEmpty())
    }
}
