package com.sam.pidash.ui.live

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

    @Test fun cachedAndReconnectingSessionsDoNotShowOldCommandsAsRunning() {
        val previous = LiveBackgroundSnapshot(tasks = listOf(task))
        listOf(liveWorkState("running", false, previous), liveWorkState("reconnecting", true, previous)).forEach { state ->
            assertFalse(state.isWorking)
            assertNull(state.backgroundCount)
            assertEquals("工作状态待同步", state.agentLabel)
            assertEquals("后台记录", state.backgroundLabel)
        }
    }
}
