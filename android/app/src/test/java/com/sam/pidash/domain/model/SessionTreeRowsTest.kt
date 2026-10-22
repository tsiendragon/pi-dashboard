package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTreeRowsTest {
    private fun entry(
        key: String,
        parent: String? = null,
        focus: Boolean = false,
        at: String = "2026-01-01T00:00:00Z",
        cwd: String = "/repo/$key",
    ) = LiveSessionTreeEntry(
        key = key, file = "/s/$key.jsonl", sessionId = key, cwd = cwd, timestamp = at,
        entryCount = 3, isFocus = focus, forkOf = parent, forkAnchorId = parent?.let { "anchor-$key" },
    )

    @Test fun aForkChainNestsUnderItsParent() {
        val rows = sessionTreeRows(listOf(entry("root"), entry("child", "root"), entry("grandchild", "child")))
        assertEquals(listOf("root", "child", "grandchild"), rows.map { it.entry.key })
        assertEquals(listOf(0, 1, 2), rows.map { it.depth })
        assertEquals(listOf(false, true, true), rows.map { it.forked })
        assertEquals(1, rows[0].forks)
    }

    @Test fun aForkSitsRightBelowItsParentAndFocusIsFlagged() {
        val rows = sessionTreeRows(listOf(entry("a"), entry("b", at = "2026-02-01"), entry("c", "a", focus = true)))
        assertEquals(listOf("a", "c", "b"), rows.map { it.entry.key })
        assertEquals(1, rows[0].forks)
        assertEquals(1, rows[1].depth)
        assertTrue(rows[1].forked)
        assertTrue(rows.single { it.entry.isFocus }.entry.key == "c")
    }

    @Test fun anOrphanParentStillShowsItsChildren() {
        val rows = sessionTreeRows(listOf(entry("child", "missing"), entry("other")))
        assertEquals(setOf("child", "other"), rows.map { it.entry.key }.toSet())
        assertTrue(rows.all { it.depth == 0 })
    }

    @Test fun aCycleIsShownOnceInsteadOfLoopingForever() {
        val rows = sessionTreeRows(listOf(entry("a", "b"), entry("b", "a")))
        assertEquals(listOf("a", "b"), rows.map { it.entry.key })
        assertEquals(2, rows.size)
    }

    @Test fun labelPrefersTheWorkingDirectoryShortName() {
        val label = sessionTreeLabel(entry("k1", focus = true, cwd = "/home/x/pi-dashboard"))
        assertTrue(label.startsWith("当前会话 pi-dashboard"))
        assertTrue(label.contains("3 条"))
    }
}
