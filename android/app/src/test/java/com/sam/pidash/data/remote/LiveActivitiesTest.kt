package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LiveActivitiesTest {
    private fun detail(vararg entries: String, status: String = "idle") = LiveDetail(
        LiveSummary("p", "s", cwd = "/allowed", status = status), entries.map { pidashJson.parseToJsonElement(it) })
    private val user = """{"type":"message","id":"u","message":{"role":"user","content":"request"}}"""
    private val answer = """{"type":"message","id":"a","message":{"role":"assistant","content":"reply"}}"""
    private val tool = """{"type":"tool_execution_end","data":{"toolCallId":"t","toolName":"read","result":{"content":[{"type":"text","text":"result"}]}}}"""

    @Test fun toolsReturningDoesNotMeanTheTaskFinished() {
        val activity = projectLiveActivities(detail(user, tool)).single()
        assertEquals("待确认", activity.state)
        assertEquals("done", activity.items.last().status)
    }
    @Test fun currentRunningAndReconnectingAreNotInferredAsComplete() {
        assertEquals("工作中", projectLiveActivities(detail(user, tool, answer, status = "running")).single().state)
        assertEquals("重连中", projectLiveActivities(detail(user, answer, status = "reconnecting")).single().state)
    }
    @Test fun idleFinalReplyIsLabelledReplyNotTaskCompletion() {
        assertEquals("已回复", projectLiveActivities(detail(user, answer)).single().state)
    }
    @Test fun priorFailuresRemainVisibleEvenIfAReplyExists() {
        val failure = """{"type":"tool_execution_end","data":{"toolCallId":"t","toolName":"read","isError":true}}"""
        val activity = projectLiveActivities(detail(user, failure, answer)).single()
        assertEquals("有失败，需检查", activity.state)
        assertTrue(activity.items.any { it.isError })
    }
    @Test fun commentaryAndThinkingDoNotMasqueradeAsFinalReplies() {
        val commentary = """{"type":"message","id":"a","message":{"role":"assistant","channel":"commentary","content":"checking"}}"""
        val thinking = """{"type":"message","id":"a","message":{"role":"assistant","content":[{"type":"thinking","thinking":"thought"},{"type":"text","text":"checking"}]}}"""
        assertEquals("待确认", projectLiveActivities(detail(user, commentary)).single().state)
        assertEquals("待确认", projectLiveActivities(detail(user, thinking)).single().state)
    }
    @Test fun aPartialReplyAndInterruptedToolAreUnconfirmed() {
        val update = """{"type":"message_update","data":{"message":{"role":"assistant","content":"partial"}}}"""
        assertEquals("待确认", projectLiveActivities(detail(user, update)).single().state)
        val start = """{"type":"tool_execution_start","data":{"toolCallId":"t","toolName":"read"}}"""
        assertEquals("执行状态待确认", projectLiveActivities(detail(user, start)).single().state)
    }
    @Test fun repeatedRealRequestsStaySeparateAndUseActualForkIds() {
        val secondUser = user.replace("\"u\"", "\"u2\"")
        val activities = projectLiveActivities(detail(user, answer, secondUser))
        assertEquals(listOf("u", "u2"), activities.map { it.id })
        assertTrue(activities.last().items.single().forkable)
    }
    @Test fun aTruncatedWindowDoesNotInventAUserRequest() {
        val activity = projectLiveActivities(detail(tool)).single()
        assertTrue(activity.title.contains("窗口内记录"))
        assertFalse(activity.items.any { it.role == "user" })
    }
    @Test fun goalCountsComeOnlyFromStructuredWorkItemsAndMalformedGoalsAreSafe() {
        val goal = pidashJson.parseToJsonElement("""{"objective":"Goal","status":"active","progress":{"current":"phase"},"workItems":[{"id":"one","title":"first","state":"done"},{"id":"two","title":"second","state":"blocked"}],"blockers":[{"title":"permission"}],"messagesSinceUpdate":301}""")
        val anchor = liveGoalAnchor(detail().copy(goal = goal))!!
        assertEquals(2, anchor.workItems.size)
        assertEquals(1, anchor.workItems.count { it.state == "done" })
        assertEquals("phase", anchor.progress.current)
        assertEquals("permission", anchor.blockers.single().title)
        assertNull(liveGoalAnchor(detail().copy(goal = JsonPrimitive("malformed"))))
    }
}
