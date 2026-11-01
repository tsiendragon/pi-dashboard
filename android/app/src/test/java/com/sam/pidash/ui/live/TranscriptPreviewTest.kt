package com.sam.pidash.ui.live

import org.junit.Assert.*
import org.junit.Test

class TranscriptPreviewTest {
    @Test fun expandedLongMessageIncludesItsEnding() {
        val text = (1..70).joinToString("\n") { "Line $it" } + "\nFINAL SENTINEL"
        val result = transcriptPreview(text, expanded = true)
        assertTrue(result.long)
        assertEquals(text, result.visible)
        assertTrue(result.visible.endsWith("FINAL SENTINEL"))
    }

    @Test fun collapsedLongMessageIsStillAvailableByExpanding() {
        val text = (1..15).joinToString("\n") { "Line $it" }
        val result = transcriptPreview(text, expanded = false)
        assertTrue(result.long)
        assertEquals(15, result.lineCount)
        assertEquals(12, result.visible.lines().size)
        assertEquals(text, transcriptPreview(text, expanded = true).visible)
    }

    @Test fun longSingleLineAndShortMessagesAreHandled() {
        val longLine = "x".repeat(1250)
        assertEquals(1200, transcriptPreview(longLine, expanded = false).visible.length)
        assertEquals(longLine, transcriptPreview(longLine, expanded = true).visible)
        assertFalse(transcriptPreview("short", expanded = false).long)
    }
}
