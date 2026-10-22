package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptGroupingTest {
    private fun tool(id: String, status: String = "done", failed: Boolean = false) =
        LiveTimelineItem(id = id, role = "tool", text = "out", toolName = "bash", status = status, isError = failed)

    private fun message(id: String, role: String = "assistant") =
        LiveTimelineItem(id = id, role = role, text = "say")

    @Test fun consecutiveCallsBecomeOneGroup() {
        val rows = groupTranscript(listOf(message("m1"), tool("t1"), tool("t2"), tool("t3"), message("m2")))
        assertEquals(3, rows.size)
        assertTrue(rows[0] is TranscriptRow.Single)
        val group = rows[1] as TranscriptRow.Steps
        assertEquals(listOf("t1", "t2", "t3"), group.items.map { it.id })
        assertTrue(rows[2] is TranscriptRow.Single)
    }

    @Test fun aLoneCallStaysASingleRow() {
        val rows = groupTranscript(listOf(message("m1"), tool("t1"), message("m2")))
        assertEquals(3, rows.size)
        assertTrue(rows.all { it is TranscriptRow.Single })
    }

    @Test fun groupExposesFailureRunningAndNames() {
        val rows = groupTranscript(listOf(tool("t1", "running"), tool("t2", "error", failed = true)))
        val group = rows.single() as TranscriptRow.Steps
        assertTrue(group.running)
        assertTrue(group.failed)
        assertEquals(listOf("bash"), group.names)
    }

    @Test fun emptyTranscriptHasNoRows() {
        assertTrue(groupTranscript(emptyList()).isEmpty())
    }
}
