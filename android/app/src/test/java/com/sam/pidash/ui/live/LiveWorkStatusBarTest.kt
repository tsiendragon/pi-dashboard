package com.sam.pidash.ui.live

import com.sam.pidash.data.remote.LiveProofJob
import com.sam.pidash.data.remote.LiveProofJobs
import com.sam.pidash.data.remote.LiveScheduleSummary
import com.sam.pidash.data.remote.LiveSubagentRecord
import com.sam.pidash.data.remote.LiveSubagentWorkflow
import com.sam.pidash.data.remote.LiveWorkflowRecord
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveWorkStatusBarTest {
    private val task = LiveBackgroundTask("bash-45c8", status = "running", mode = "background")

    @Test fun idleAgentStillShowsRunningBackgroundCommands() {
        val state = liveWorkState("idle", true, LiveBackgroundSnapshot(tasks = listOf(
            task,
            task.copy(taskId = "starting", status = "starting"),
            task.copy(taskId = "foreground", mode = "foreground"),
            task.copy(taskId = "finished", status = "succeeded"),
        )))
        assertFalse(state.agentRunning)
        assertTrue(state.isWorking)
        assertEquals("主 Agent 空闲", state.agentLabel)
        assertEquals("后台 2 个运行中", state.backgroundLabel)
    }

    @Test fun knownEmptyAndMissingBackgroundStatusAreDifferent() {
        val finished = liveWorkState("idle", true, LiveBackgroundSnapshot(tasks = listOf(task.copy(status = "succeeded"))))
        assertFalse(finished.isWorking)
        assertEquals("无后台命令运行", finished.backgroundLabel)
        val unknown = liveWorkState("running", true, null)
        assertTrue(unknown.isWorking)
        assertEquals("后台状态未知", unknown.backgroundLabel)
    }

    @Test fun scheduledWorkWaitsAutomaticallyWithoutPretendingToExecute() {
        val schedule = LiveScheduleSummary(2, 12_345)
        val state = liveWorkState("idle", true, LiveBackgroundSnapshot(), schedule)
        assertTrue(state.isWorking)
        assertFalse(state.isExecuting)
        assertEquals(schedule, state.schedule)
        assertEquals("无需额外输入", state.scheduleHint)
        assertEquals("有待处理的请求", liveWorkState("idle", true, null, schedule, needsInput = true).scheduleHint)
        assertNull(liveWorkState("reconnecting", true, null, schedule).schedule)
        assertNull(liveWorkState("idle", false, null, schedule).schedule)
    }

    @Test fun idleAgentStillShowsRunningSubagentsAndWorkflows() {
        val work = LiveSubagentWorkflow(
            agents = listOf(LiveSubagentRecord("top", "检查 API", "running")),
            workflows = listOf(LiveWorkflowRecord("wf", "发布流程", "running", currentStage = 0, stageCount = 2, taskTotal = 2, taskDone = 1)),
            agentsTotal = 1,
            agentsRunning = 1,
            workflowsTotal = 1,
            workflowsActive = 1,
        )
        val state = liveWorkState("idle", true, LiveBackgroundSnapshot(), subagentWorkflow = work)
        assertFalse(state.agentRunning)
        assertTrue(state.isExecuting)
        assertEquals("主 Agent 空闲", state.agentLabel)
        assertEquals("1 个子 Agent 运行中 · 1 个工作流进行中", state.subagentWorkflowLabel)
        assertEquals("阶段 1/2 · 任务 1/2 完成", work.workflows.single().progressLabel)
    }

    @Test fun blockedSubagentIsAttentionWithoutPretendingTheMainAgentIsRunning() {
        val work = LiveSubagentWorkflow(
            agents = listOf(LiveSubagentRecord("blocked", "等待批准", "blocked", needsAttention = true)),
            agentsTotal = 1,
            agentsAttention = 1,
        )
        val state = liveWorkState("idle", true, LiveBackgroundSnapshot(), subagentWorkflow = work)
        assertFalse(state.isExecuting)
        assertTrue(state.isWorking)
        assertTrue(state.hasAttention)
        assertEquals("1 个子 Agent 待处理", state.subagentWorkflowLabel)
        assertEquals("1 个子 Agent 待处理", work.summaryLabel)
    }

    @Test fun cachedAndReconnectingSessionsDoNotShowOldCommandsAsRunning() {
        val previous = LiveBackgroundSnapshot(tasks = listOf(task))
        listOf(liveWorkState("running", false, previous), liveWorkState("reconnecting", true, previous)).forEach { state ->
            assertFalse(state.isWorking)
            assertNull(state.backgroundCount)
            assertEquals("工作状态待同步", state.agentLabel)
            assertEquals("后台记录", state.backgroundLabel)
        }
    }

    @Test fun cachedOrReconnectingSessionsDoNotShowStaleWorkbenchStatus() {
        val work = LiveSubagentWorkflow(agentsRunning = 1, workflowsActive = 1)
        listOf(liveWorkState("running", false, null, subagentWorkflow = work),
            liveWorkState("reconnecting", true, null, subagentWorkflow = work)).forEach { state ->
            assertFalse(state.isWorking)
            assertNull(state.subagentWorkflowLabel)
        }
    }

    @Test fun proofJobsKeepAnIdleAgentWorkingAndStayHiddenWhenStale() {
        val jobs = LiveProofJobs(listOf(
            LiveProofJob("pj-1", "Lemma 1", "running", startedAt = 1_000),
            LiveProofJob("pj-2", "Lemma 2", "queued"),
            LiveProofJob("pj-3", "Lemma 3", "finished"),
        ))
        val state = liveWorkState("idle", true, LiveBackgroundSnapshot(), proofJobs = jobs)
        assertTrue(state.isExecuting)
        assertEquals("证明任务 1 个运行中 · 1 个排队 · 共 3 个", state.proofJobsLabel)
        val settled = liveWorkState("idle", true, LiveBackgroundSnapshot(), proofJobs = LiveProofJobs(listOf(jobs.jobs[2])))
        assertFalse(settled.isWorking)
        assertEquals("证明任务 无运行中 · 共 1 个", settled.proofJobsLabel)
        assertNull(liveWorkState("idle", true, null, proofJobs = LiveProofJobs(emptyList())).proofJobsLabel)
        assertNull(liveWorkState("reconnecting", true, null, proofJobs = jobs).proofJobsLabel)
        assertEquals("已运行 1m 30s", proofJobTiming(jobs.jobs[0], now = 91_000))
        assertEquals("等待空位", proofJobTiming(jobs.jobs[1], now = 0))
        assertEquals("", proofJobTiming(jobs.jobs[2], now = 0))
    }
}
