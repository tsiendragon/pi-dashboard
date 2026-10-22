package com.sam.pidash.notify

import com.sam.pidash.domain.model.LiveSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveAlertsTest {
    private fun summary(process: String = "p1", status: String = "idle", name: String? = "会话") =
        LiveSummary(processInstanceId = process, sessionId = "s", sessionName = name, cwd = "/w", status = status)

    @Test fun finishingARunNotifiesOnce() {
        val alert = findLiveAlert("p1", summary(status = "running"), summary(status = "idle"), 0, 0, "会话")!!
        assertEquals(LiveAlertKind.COMPLETED, alert.kind)
        assertTrue(alert.title.startsWith("已完成"))
        assertNull(findLiveAlert("p1", summary(status = "idle"), summary(status = "idle"), 0, 0, "会话"))
    }

    @Test fun aNewPendingPromptNeedsInput() {
        val alert = findLiveAlert("p1", summary(status = "running"), summary(status = "running"), 0, 1, "会话")!!
        assertEquals(LiveAlertKind.NEEDS_INPUT, alert.kind)
        assertTrue(alert.title.startsWith("需要你回答"))
        // An already-answerable prompt that stays pending must not re-notify.
        assertNull(findLiveAlert("p1", summary(status = "running"), summary(status = "running"), 1, 1, "会话"))
    }

    @Test fun theFirstSightingOfASessionDoesNotNotify() {
        assertNull(findLiveAlert("p1", null, summary(status = "idle"), 0, 0, "会话"))
    }

    @Test fun titlesAreCappedForTheShade() {
        val long = "x".repeat(200)
        assertEquals(60, notificationTitle(long).length)
        assertTrue(notificationTitle(long).endsWith("…"))
        assertEquals("short", notificationTitle("short"))
    }
}
