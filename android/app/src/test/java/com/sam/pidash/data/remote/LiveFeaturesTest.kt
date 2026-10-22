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
}
