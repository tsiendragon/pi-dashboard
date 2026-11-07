package com.sam.pidash.domain.model

import org.junit.Assert.*
import org.junit.Test

class DetailTraceEntriesTest {
    private fun thought(id: String) = LiveTimelineItem(id, "assistant", "", thinking = "思考 $id")
    private fun tool(id: String) = LiveTimelineItem(id, "tool", "输出 $id", toolName = "read", toolCallId = id)
    private fun flatten(rows: List<DetailTraceEntry>) = rows.flatMap { it.precedingThinking + it.item }

    @Test fun adjacentThinkingSharesTheFollowingToolRow() {
        val thoughts = listOf(thought("a"), thought("b"))
        val rows = detailTraceEntries(thoughts + tool("c"))
        assertEquals(1, rows.size)
        assertEquals(thoughts, rows.single().precedingThinking)
        assertEquals("c", rows.single().item.id)
    }
    @Test fun trailingThinkingAndThinkingOnlyRemainAccessible() {
        val input = listOf(thought("a"), tool("b"), thought("c"), thought("d"))
        val rows = detailTraceEntries(input)
        assertEquals(3, rows.size)
        assertEquals(input, flatten(rows))
        assertEquals(input.takeLast(2), detailTraceEntries(input.takeLast(2)).map { it.item })
    }
    @Test fun neverCrossesMessagesImagesOrErrors() {
        val barriers = listOf(
            LiveTimelineItem("reply", "assistant", "正常回复", thinking = "附带思考"),
            thought("error").copy(isError = true),
            thought("image").copy(images = listOf(LiveImage("image/png", "fixture"))),
        )
        barriers.forEach { barrier ->
            val input = listOf(thought("a"), barrier, tool("b"))
            val rows = detailTraceEntries(input)
            assertEquals(3, rows.size)
            assertTrue(rows.last().precedingThinking.isEmpty())
            assertEquals(input, flatten(rows))
        }
    }
    @Test fun screenshotSizedTraceShrinksFrom83RowsTo46WithoutLosingOrder() {
        val input = buildList {
            add(tool("first"))
            repeat(37) { add(thought("t$it")); add(tool("c$it")) }
            repeat(8) { add(tool("last$it")) }
        }
        val rows = detailTraceEntries(input)
        assertEquals(83, input.size)
        assertEquals(46, rows.size)
        assertEquals(input, flatten(rows))
        val trace = ActivityDetailRow.Trace(input)
        assertEquals(46, trace.toolCount)
        assertEquals(37, trace.thinkingCount)
    }
    @Test fun emptyAndToolsOnlyStayUnchanged() {
        assertTrue(detailTraceEntries(emptyList()).isEmpty())
        val input = listOf(tool("a"), tool("b"))
        assertEquals(input, detailTraceEntries(input).map { it.item })
    }
}
