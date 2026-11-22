package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask
import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveFeaturesTest {
    private fun detail(vararg entries: String) = LiveDetail(
        summary = LiveSummary(processInstanceId = "p", sessionId = "s", cwd = "/w"),
        entries = entries.map { Json.parseToJsonElement(it) as JsonElement },
    )

    private fun event(feature: String, snapshot: String) =
        """{"type":"live_feature_snapshot","data":{"feature":"$feature","snapshot":$snapshot}}"""

    @Test fun theLatestBackgroundSnapshotWins() {
        val first = event("background-commands", """{"revision":1,"tasks":[{"taskId":"bash-aaaa","status":"running"}]}""")
        val second = event("background-commands", """{"revision":2,"tasks":[{"taskId":"bash-bbbb","status":"done","exitCode":0}]}""")
        val snapshot = backgroundSnapshot(detail(first, second))!!
        assertEquals(2, snapshot.revision)
        assertEquals(listOf("bash-bbbb"), snapshot.tasks.map { it.taskId })
        assertEquals(0, snapshot.tasks.single().exitCode)
    }

    @Test fun scheduleUsesEarliestValidTimeAndClearsWhenLatestListIsEmpty() {
        val active = event("schedule", """{"tasks":[{"id":"later","nextRunAt":9000},{"id":"sooner","nextRunAt":2000},{"id":"bad","nextRunAt":"invalid"}]}""")
        val rescheduled = event("schedule", """{"tasks":[{"id":"later","nextRunAt":9000},{"id":"sooner","nextRunAt":8000}]}""")
        val cleared = event("schedule", """{"tasks":[]}""")
        assertEquals(LiveScheduleSummary(2, 2000), scheduleSummary(detail(active)))
        assertEquals(LiveScheduleSummary(2, 8000), scheduleSummary(detail(active, rescheduled)))
        assertNull(scheduleSummary(detail(active, cleared)))
        assertNull(scheduleSummary(null))
    }

    @Test fun otherFeaturesAndMissingSnapshotsAreIgnored() {
        assertNull(backgroundSnapshot(detail(event("btw", """{"revision":1}"""))))
        assertNull(backgroundSnapshot(detail("""{"type":"message","id":"m"}""")))
        assertNull(backgroundSnapshot(null))
    }

    @Test fun garbageSnapshotIsDroppedInsteadOfCrashing() {
        assertNull(backgroundSnapshot(detail(event("background-commands", """{"tasks":"nope"}"""))))
    }

    @Test fun onlyARunningForegroundCallMayMoveToBackground() {
        val tasks = listOf(
            LiveBackgroundTask("bash-1", status = "running", mode = "foreground", toolCallId = "call-1"),
            LiveBackgroundTask("bash-2", status = "running", mode = "background", toolCallId = "call-2"),
            LiveBackgroundTask("bash-3", status = "done", mode = "foreground", toolCallId = "call-3"),
            LiveBackgroundTask("bash-4", status = "running", mode = "foreground"),
        )
        assertEquals(listOf("bash-1"), tasks.filter { it.canMoveToBackground() }.map { it.taskId })
        assertTrue(tasks[0].isActive())
        assertFalse(tasks[2].isActive())
    }

    @Test fun elapsedUsesTheEndTimeWhenFinished() {
        val task = LiveBackgroundTask("bash-1", status = "done", startedAt = 1_000, endedAt = 61_000)
        assertEquals(60, task.elapsedSeconds(now = 999_999))
        assertEquals(5, task.copy(endedAt = null, startedAt = 0).elapsedSeconds(now = 5_000))
    }

    @Test fun subagentWorkflowSeparatesTopLevelAgentsAndWorkflowChildren() {
        val snapshot = event("subagent-workflow", """{
            "revision":4,
            "conversations":{
                "total":4,"running":2,"needsAttention":1,"completed":1,
                "items":[
                    {"id":"top","label":"检查 API","status":"running","activeRunId":"run-1"},
                    {"id":"blocked","label":"等待批准","status":"running","needsAttention":true},
                    {"id":"child","label":"阶段任务","status":"running","workflowId":"wf-1"},
                    {"id":"done","label":"已完成","status":"completed"}
                ]
            },
            "workflows":{
                "total":2,"active":1,"failed":0,
                "items":[
                    {"id":"wf-1","label":"发布流程","status":"running","currentStage":1,
                     "stages":[
                        {"id":"s1","status":"completed","tasks":[{"id":"t1","status":"completed"}]},
                        {"id":"s2","status":"running","tasks":[{"id":"t2","status":"running"}]}
                     ]},
                    {"id":"wf-2","label":"旧流程","status":"completed","stages":[]}
                ]
            }
        }""")
        val work = subagentWorkflow(detail(snapshot))!!
        assertEquals(3, work.agentsTotal)
        assertEquals(1, work.agentsRunning)
        assertEquals(1, work.agentsAttention)
        assertEquals(2, work.workflowsTotal)
        assertEquals(1, work.workflowsActive)
        assertTrue(work.isExecuting)
        assertEquals("1 个子 Agent 运行中 · 1 个子 Agent 待处理 · 1 个工作流进行中", work.summaryLabel)
        // Workflow child conversations must not be counted as another top-level subagent.
        assertFalse(work.agents.any { it.id == "child" })
        val workflow = work.workflows.first { it.id == "wf-1" }
        assertEquals("阶段 2/2 · 任务 1/2 完成", workflow.progressLabel)
        assertEquals("需处理", liveWorkStatusLabel("blocked"))
    }

    @Test fun subagentWorkflowFallsBackToCountsWhenItemsAreAbsent() {
        val snapshot = event("subagent-workflow", """{
            "conversations":{"total":2,"running":1,"needsAttention":0},
            "workflows":{"total":3,"active":2,"failed":1}
        }""")
        val work = subagentWorkflow(detail(snapshot))!!
        assertEquals(2, work.agentsTotal)
        assertEquals(1, work.agentsRunning)
        assertEquals(3, work.workflowsTotal)
        assertEquals(2, work.workflowsActive)
        assertEquals(1, work.workflowsFailed)
        assertEquals("1 个子 Agent 运行中 · 2 个工作流进行中 · 1 个工作流失败", work.summaryLabel)
        assertTrue(work.hasAttention)
    }

    @Test fun subagentWorkflowNeedsAPublishedFeatureObject() {
        assertNull(subagentWorkflow(null))
        assertNull(subagentWorkflow(detail()))
        assertNull(subagentWorkflow(detail(event("btw", """{"revision":1}"""))))
        assertNull(subagentWorkflow(detail(event("subagent-workflow", """{"conversations":[]}"""))))
    }


    @Test fun backgroundCommandsFallBackToToolResultsWhenTheFeatureIsMissing() {
        val start = """{"type":"message_end","data":{"message":{"role":"toolResult","toolName":"background_command_start","timestamp":"2026-11-01T10:00:00Z","details":{"taskId":"bash-abcd","title":"dev server","status":"running","mode":"background"}}}}"""
        val snapshot = backgroundSnapshot(detail(start))!!
        assertEquals(listOf("bash-abcd"), snapshot.activeBackgroundTasks().map { it.taskId })
        assertEquals("dev server", snapshot.tasks.single().title)
        assertTrue(snapshot.tasks.single().startedAt > 0)
        val finished = """{"type":"message_end","data":{"message":{"role":"toolResult","toolName":"background_command_status","details":{"taskId":"bash-abcd","title":"dev server","status":"exited","mode":"background","exitCode":0}}}}"""
        assertTrue(backgroundSnapshot(detail(start, finished))!!.activeBackgroundTasks().isEmpty())
    }

    @Test fun subagentWorkflowFallsBackToTranscriptWithoutAFeatureSnapshot() {
        val call = """{"type":"message_end","data":{"message":{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"subagent_start","arguments":{"label":"核对登录流程","task":"review"}}]}}}"""
        val start = """{"type":"message_end","data":{"message":{"role":"toolResult","toolCallId":"call-1","toolName":"subagent_start","details":{"status":"queued","background":true,"workId":"work-a"},"content":[{"type":"text","text":"Subagent accepted in background (work-a)."}]}}}"""
        val running = """{"type":"message_end","data":{"message":{"role":"toolResult","toolName":"subagent_results","details":{"status":"completed","mode":"status","pending":[{"workId":"work-a","kind":"agent","status":"running"}],"completed":[]},"content":[{"type":"text","text":"work-a · agent · running · 核对登录流程"}]}}}"""
        val work = subagentWorkflow(detail(call, start, running))!!
        assertEquals(1, work.agentsRunning)
        assertTrue(work.isExecuting)
        assertEquals("核对登录流程", work.agents.single().label)
        assertEquals("1 个子 Agent 运行中", work.summaryLabel)

        val done = """{"type":"message_end","data":{"message":{"role":"toolResult","toolName":"subagent_results","details":{"status":"completed","mode":"status","pending":[],"completed":[{"workId":"work-a","kind":"agent","status":"completed"}]},"content":[{"type":"text","text":"work-a · agent · completed · 核对登录流程"}]}}}"""
        val settled = subagentWorkflow(detail(call, start, running, done))!!
        assertFalse(settled.isExecuting)
        assertNull(settled.summaryLabel)
        assertEquals("completed", settled.agents.single().status)
    }

    @Test fun workflowFallbackTracksBackgroundWorkflowUntilItSettles() {
        val call = """{"type":"message_end","data":{"message":{"role":"assistant","content":[{"type":"toolCall","id":"call-w","name":"subagent_workflow","arguments":{"label":"发布检查"}}]}}}"""
        val start = """{"type":"message_end","data":{"message":{"role":"toolResult","toolCallId":"call-w","toolName":"subagent_workflow","details":{"status":"queued","background":true,"workId":"work-w","workflowId":"wf-1"},"content":[{"type":"text","text":"Workflow accepted in background (work-w)."}]}}}"""
        val running = subagentWorkflow(detail(call, start))!!
        assertEquals(1, running.workflowsActive)
        assertEquals("发布检查", running.workflows.single().label)
        assertEquals("1 个工作流进行中", running.summaryLabel)

        val done = """{"type":"message_end","data":{"message":{"role":"toolResult","toolName":"subagent_results","details":{"status":"completed","mode":"status","pending":[],"completed":[{"workId":"work-w","kind":"workflow","status":"completed"}]},"content":[{"type":"text","text":"work-w · workflow · completed · 发布检查"}]}}}"""
        val settled = subagentWorkflow(detail(call, start, done))!!
        assertFalse(settled.isExecuting)
        assertNull(settled.summaryLabel)
    }

    @Test fun emptyFeatureSnapshotFallsBackButPublishedRecordsStayAuthoritative() {
        val active = """{"type":"message_end","data":{"message":{"role":"toolResult","toolName":"subagent_start","details":{"status":"running","workId":"work-live"}}}}"""
        val empty = event("subagent-workflow", """{"conversations":{"items":[]},"workflows":{"items":[]}}""")
        assertTrue(subagentWorkflow(detail(empty, active))!!.isExecuting)
        val retained = event("subagent-workflow", """{"conversations":{"items":[{"id":"work-live","label":"已结束","status":"completed"}]},"workflows":{"items":[]}}""")
        val work = subagentWorkflow(detail(retained, active))!!
        assertEquals("completed", work.agents.single().status)
        assertFalse(work.isExecuting)
    }

    @Test fun proofJobsAreValidatedAndOrderedLiveFirst() {
        assertNull(proofJobs(detail()))
        assertNull(proofJobs(detail(event("proof-jobs", """{"tasks":"nope"}"""))))
        val stale = event("proof-jobs", """{"tasks":[{"id":"pj-old","label":"Old","state":"running"}]}""")
        val latest = event("proof-jobs", """{"tasks":[
            {"id":"pj-done","label":"Lemma 2","state":"finished","createdAt":1000,"startedAt":2000,"finishedAt":62000},
            {"id":"pj-q","label":"Lemma 3","state":"queued","createdAt":5000},
            {"id":"pj-run","label":"Lemma 1","state":"running","startedAt":3000,"collected":true},
            {"id":"pj-odd","state":"cancelling","startedAt":"yesterday"},
            {"id":"pj-run","label":"duplicate","state":"failed"},
            {"label":"no id","state":"running"}
        ]}""")
        val jobs = proofJobs(detail(stale, latest))!!
        assertEquals(listOf("pj-run", "pj-q", "pj-done", "pj-odd"), jobs.jobs.map { it.id })
        assertEquals(1, jobs.running)
        assertEquals(1, jobs.queued)
        assertEquals("unknown", jobs.jobs[3].state)
        assertEquals("pj-odd", jobs.jobs[3].label)
        assertNull(jobs.jobs[3].startedAt)
        assertEquals(true, jobs.jobs[0].collected)
        assertNull(jobs.jobs[2].collected)
        assertEquals(62_000L, jobs.jobs[2].finishedAt)
    }
}
