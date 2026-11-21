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

    @Test fun subagentWorkUsesWebStatusPrecedenceAndDoesNotCountWorkflowChildrenTwice() {
        val snapshot = event("subagent-workflow", """{
            "conversations":{"running":99,"items":[
                {"id":"a","status":"idle","activeRunId":"r"},
                {"id":"b","status":"running","latestRunStatus":"queued"},
                {"id":"c","status":"running","stalled":true},
                {"id":"d","status":"running","workflowId":"w"},
                {"id":"e","status":"running","parentWorkflowId":"w"},
                {"id":"f","status":"running","workflowTaskId":"t"},
                null, "bad", {"status":true}, {"status":"new-state"}
            ]},
            "workflows":{"active":99,"items":[
                {"id":"w","status":"running","stages":[{"tasks":[{"status":"running"}]}]},
                {"id":"q","status":"queued"}, {"id":"p","status":"paused"}, {"id":"z","status":"completed"}
            ]}
        }""")
        val work = subagentWork(detail(snapshot, event("background-commands", """{"tasks":[]}""")))!!
        assertEquals(LiveWorkCounts(1, 1), work.subagents)
        assertEquals(LiveWorkCounts(1, 1), work.workflows)
    }

    @Test fun subagentWorkUsesLatestSnapshotIncludingAnExplicitClear() {
        val running = event("subagent-workflow", """{"workflows":{"items":[{"id":"w","status":"running"}]}}""")
        val settled = event("subagent-workflow", """{"workflows":{"items":[{"id":"w","status":"completed"}]}}""")
        val empty = event("subagent-workflow", """{"conversations":{"items":[]},"workflows":{"items":[]}}""")
        val clear = """{"type":"live_feature_snapshot","data":{"feature":"subagent-workflow"}}"""
        assertNull(subagentWork(detail(event("background-commands", """{"tasks":[]}"""))))
        assertEquals(1, subagentWork(detail(running))?.active)
        assertEquals(0, subagentWork(detail(running, settled))?.active)
        assertEquals(0, subagentWork(detail(running, empty))?.active)
        assertNull(subagentWork(detail(running, clear)))
        assertNull(subagentWork(detail(running, event("subagent-workflow", "null"))))
        assertNull(subagentWork(detail(running, event("subagent-workflow", """{"workflows":{"items":true}}"""))))
    }

    @Test fun subagentWorkUpdatesFromTheExistingLiveEventReducer() {
        fun update(sequence: Int, status: String) = Json.parseToJsonElement("""{
            "type":"event","processInstanceId":"p","sequence":$sequence,
            "event":${event("subagent-workflow", """{"workflows":{"items":[{"id":"w","status":"$status"}]}}""")}
        }""") as kotlinx.serialization.json.JsonObject
        val running = reduceLiveEvent(detail(), update(1, "running"))!!
        val done = reduceLiveEvent(running, update(2, "completed"))!!
        assertEquals(1, subagentWork(running)?.running)
        assertEquals(0, subagentWork(done)?.active)
        assertEquals(1, done.entries.size)
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
