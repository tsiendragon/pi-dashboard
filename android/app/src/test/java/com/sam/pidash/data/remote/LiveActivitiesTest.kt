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
    @Test fun quoteAndCommentFollowUpsAttachToQuotedActivityInsteadOfSplittingTurns() {
        val firstReply = """{"type":"message","id":"a1","message":{"role":"assistant","content":"第一轮结论：需要检查配置文件路径"}}"""
        val secondUser = """{"type":"message","id":"u2","message":{"role":"user","content":"第二个独立请求"}}"""
        val secondReply = """{"type":"message","id":"a2","message":{"role":"assistant","content":"第二轮结论：测试已通过"}}"""
        val quoteFollowUp = """{"type":"message","id":"u3","message":{"role":"user","content":"引用（来自你的回复）：\n> 第一轮结论：需要检查配置文件路径\n\n请把路径打印出来"}}"""
        val followUpReply = """{"type":"message","id":"a3","message":{"role":"assistant","content":"路径是 /allowed/config.json"}}"""
        val activities = projectLiveActivities(detail(user, firstReply, secondUser, secondReply, quoteFollowUp, followUpReply))
        assertEquals(listOf("u", "u2"), activities.map { it.id })
        assertEquals(listOf("u", "a1", "u3", "a3"), activities.first().items.map { it.id })
        assertEquals("已回复", activities.first().state)
        assertEquals(listOf("a1", "u3", "a3"), activityOverview(activities.first()).map { it?.id })
    }
    @Test fun unsettledFollowUpReopensActivityUntilAnswered() {
        val firstReply = """{"type":"message","id":"a1","message":{"role":"assistant","content":"第一轮结论：需要检查配置文件路径"}}"""
        val commentFollowUp = """{"type":"message","id":"u2","message":{"role":"user","content":"Please review and address these comments about the quoted parts of our conversation:\n\n[1] 你的回复\nQuoted: \"第一轮结论：需要检查配置文件路径\"\nComment: 再核对一次权限"}}"""
        val activity = projectLiveActivities(detail(user, firstReply, commentFollowUp, tool)).single()
        assertEquals(listOf("u", "a1", "u2", "tool-call-t"), activity.items.map { it.id })
        assertEquals("待确认", activity.state)
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

/** The default (activity) view must show replies, not every intermediate record. */
class ActivityViewProjectionTest {
    private fun item(
        id: String,
        role: String,
        text: String,
        intermediate: Boolean = false,
        status: String = "done",
        toolName: String? = null,
    ) = com.sam.pidash.domain.model.LiveTimelineItem(
        id = id, role = role, text = text, intermediate = intermediate, status = status, toolName = toolName,
    )

    private fun activity(vararg items: com.sam.pidash.domain.model.LiveTimelineItem) =
        com.sam.pidash.domain.model.LiveActivity("a1", "prompt", "已回复", items.toList())

    @Test fun onlyFinalAssistantTextIsShown() {
        val replies = activityReplies(
            activity(
                item("u1", "user", "问题"),
                item("a0", "assistant", "先看目录", intermediate = true),
                item("t1", "tool", "output", toolName = "bash"),
                item("a1", "assistant", "答案是 42"),
            )
        )
        assertEquals(listOf("答案是 42"), replies.map { it.text })
    }

    @Test fun anInterruptedTurnFallsBackToItsLastText() {
        val replies = activityReplies(
            activity(
                item("a0", "assistant", "正在处理", intermediate = true),
                item("t1", "tool", "output", status = "running", toolName = "bash"),
            )
        )
        assertEquals(listOf("正在处理"), replies.map { it.text })
    }

    @Test fun activityOverviewPreservesRecordOrderAndMakesTruncationExplicit() {
        val records = activity(
            item("u", "user", "问题"), item("c", "assistant", "先检查", intermediate = true),
            item("t1", "tool", "输出", toolName = "read"), item("a", "assistant", "接着检查", intermediate = true),
            item("t2", "tool", "输出", toolName = "bash"), item("t3", "tool", "输出", toolName = "grep"),
            item("f", "assistant", "最终答复"),
        )
        assertEquals(listOf("c", "t1", "a", "t2", null, "f"), activityOverview(records).map { it?.id })
        assertEquals(listOf("c", "t1", "a", "t2", "t3", "f"), activityOverview(records, 6).map { it?.id })
    }

    @Test fun toolsAreCountedForTheOneLineSummary() {
        val tools = activityTools(
            activity(
                item("u1", "user", "问题"),
                item("t1", "tool", "out", toolName = "bash"),
                item("t2", "tool", "out", toolName = "read"),
                item("a1", "assistant", "答案"),
            )
        )
        assertEquals(listOf("bash", "read"), tools.map { it.toolName })
    }
}

/** The card status must say *what* the agent is doing, not just "working". */
class ActivityStatusTest {
    private fun item(
        id: String,
        role: String,
        text: String = "",
        status: String = "done",
        toolName: String? = null,
        error: Boolean = false,
    ) = com.sam.pidash.domain.model.LiveTimelineItem(
        id = id, role = role, text = text, status = status, toolName = toolName, isError = error,
    )

    private fun status(state: String, vararg items: com.sam.pidash.domain.model.LiveTimelineItem) =
        com.sam.pidash.domain.model.activityStatus(
            com.sam.pidash.domain.model.LiveActivity("a", "p", state, items.toList())
        )

    @Test fun aRunningToolNamesItsVerb() {
        val running = status("工作中", item("u", "user", "做点事"), item("t", "tool", status = "running", toolName = "bash"))
        assertEquals(com.sam.pidash.domain.model.ActivityPhase.COMMAND, running.phase)
        assertEquals("执行命令", running.label)
        assertTrue(running.running)

        assertEquals("读取文件", status("工作中", item("t", "tool", status = "running", toolName = "read")).label)
        assertEquals("写入文件", status("工作中", item("t", "tool", status = "running", toolName = "write")).label)
        assertEquals("搜索", status("工作中", item("t", "tool", status = "running", toolName = "grep")).label)
    }

    @Test fun thinkingComesBeforeAnyText() {
        assertEquals("思考中", status("工作中", item("u", "user", "问题")).label)
        assertEquals("回复中", status("工作中", item("a", "assistant", "正在回答")).label)
    }

    @Test fun finishedAndFailedAreDistinct() {
        val done = status("已回复", item("a", "assistant", "答案"))
        assertEquals(com.sam.pidash.domain.model.ActivityPhase.DONE, done.phase)
        assertFalse(done.running)

        val failed = status("有失败，需检查", item("t", "tool", error = true))
        assertEquals(com.sam.pidash.domain.model.ActivityPhase.FAILED, failed.phase)
        assertTrue(failed.failed)
    }

    @Test fun previewStripsMarkdownAndKeepsProse() {
        val text = """
            ## 结论
            这里有 **重点** 和 `inline` 代码。

            ```kotlin
            val a = 1
            val b = 2
            val c = 3
            ```
            - 第一点
            - 第二点
        """.trimIndent()
        val preview = com.sam.pidash.domain.model.activityPreview(text)
        assertFalse(preview.contains("**"))
        assertFalse(preview.contains("```"))
        assertTrue(preview.startsWith("结论"))
        assertTrue(preview.contains("重点"))
        assertTrue(preview.contains("第一点"))
        // At most two code lines survive, and the third never shows.
        assertFalse(preview.contains("val c"))
    }

    @Test fun previewCutsLongTextAtASentenceBoundary() {
        val long = (1..40).joinToString("") { "第${it}句很短。" }
        val preview = com.sam.pidash.domain.model.activityPreview(long, maxLines = 2)
        assertTrue(preview.endsWith("。") || preview.endsWith("…"))
        assertTrue(preview.length < long.length)
    }
}
