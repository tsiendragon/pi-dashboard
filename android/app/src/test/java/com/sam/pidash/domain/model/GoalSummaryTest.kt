package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GoalSummaryTest {
    private fun goal(
        status: String? = "active",
        items: List<String> = listOf("done", "todo", "in_progress"),
        messagesSinceUpdate: Int = 0,
        blockers: List<LiveGoalBlocker> = emptyList(),
    ) = LiveGoalAnchor(
        objective = "ship it",
        status = status,
        progress = LiveGoalProgress(current = null),
        workItems = items.mapIndexed { index, state -> LiveGoalItem("w$index", "item $index", state) },
        blockers = blockers,
        messagesSinceUpdate = messagesSinceUpdate,
    )

    @Test fun countsAndPercentFollowTheWorkItems() {
        val summary = goalSummary(goal())!!
        assertEquals(1, summary.done)
        assertEquals(3, summary.total)
        assertEquals(33, summary.percent)
        assertEquals("进行中", summary.statusLabel)
        assertNull(summary.stale)
    }

    @Test fun statusLabelsMatchTheWebUi() {
        assertEquals("已暂停", goalSummary(goal(status = "paused"))!!.statusLabel)
        assertEquals("已完成", goalSummary(goal(status = "complete"))!!.statusLabel)
        assertEquals("未标注", goalSummary(goal(status = null))!!.statusLabel)
    }

    @Test fun aCompleteGoalWithOpenItemsIsFlagged() {
        val summary = goalSummary(goal(status = "complete"))!!
        assertEquals(GoalStaleness.COMPLETE_WITH_OPEN_ITEMS, summary.stale)
        assertTrue(summary.staleMessage.contains("仍有未完成"))
    }

    @Test fun silenceBeyondTheThresholdIsFlaggedButSilenceBelowIsNot() {
        assertNull(goalSummary(goal(messagesSinceUpdate = GOAL_STALE_MESSAGE_THRESHOLD - 1))!!.stale)
        assertEquals(
            GoalStaleness.NO_RECENT_UPDATE,
            goalSummary(goal(messagesSinceUpdate = GOAL_STALE_MESSAGE_THRESHOLD))!!.stale,
        )
    }

    @Test fun blockersWaitingOnTheUserAreCounted() {
        val summary = goalSummary(
            goal(blockers = listOf(
                LiveGoalBlocker("a", disposition = "needs_user", owner = "user", kind = "user_decision"),
                LiveGoalBlocker("b", disposition = "external_wait"),
            ))
        )!!
        assertEquals(1, summary.needsUser)
        assertEquals("待用户决定", blockerKindLabel("user_decision"))
        assertEquals("用户", blockerOwnerLabel("user"))
        assertEquals("阻塞", blockerKindLabel(null))
    }

    @Test fun glyphsAndLabelsCoverEveryState() {
        assertEquals(listOf("○", "◐", "✓", "!", "⏸"),
            listOf("todo", "in_progress", "done", "blocked", "deferred").map(::workItemGlyph))
        assertEquals("待做", workItemLabel("todo"))
        assertEquals("未标注", workItemLabel(null))
    }

    @Test fun noGoalProducesNoSummary() {
        assertNull(goalSummary(null))
    }
}
