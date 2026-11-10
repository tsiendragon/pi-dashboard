package com.sam.pidash.notify

import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.LiveUiRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveAlertsTest {
    private fun summary(process: String = "p1", status: String = "idle", name: String? = "会话") =
        LiveSummary(processInstanceId = process, sessionId = "s", sessionName = name, cwd = "/w", status = status)

    private fun request(id: String = "ui-1", method: String = "confirm") =
        LiveUiRequest(id = id, method = method, title = "允许运行命令？")

    @Test fun finishingARunNotifiesOnce() {
        val alert = findLiveAlert("b1", "p1", summary(status = "running"), summary(status = "idle"), emptyList(), emptyList(), "会话")!!
        assertEquals(LiveAlertKind.COMPLETED, alert.kind)
        assertTrue(alert.title.startsWith("已完成"))
        assertNull(findLiveAlert("b1", "p1", summary(status = "idle"), summary(status = "idle"), emptyList(), emptyList(), "会话"))
    }

    @Test fun aNewPendingPromptNeedsInput() {
        val pending = listOf(request())
        val alert = findLiveAlert("b1", "p1", summary(status = "running"), summary(status = "running"), emptyList(), pending, "会话")!!
        assertEquals(LiveAlertKind.NEEDS_INPUT, alert.kind)
        assertTrue(alert.title.startsWith("需要你回答"))
        assertEquals("ui-1", alert.request?.id)
        // An already-answerable prompt that stays pending must not re-notify.
        assertNull(findLiveAlert("b1", "p1", summary(status = "running"), summary(status = "running"), pending, pending, "会话"))
    }

    @Test fun aSecondDistinctRequestNotifiesAgain() {
        val alert = findLiveAlert(
            "b1", "p1", summary(status = "running"), summary(status = "running"),
            listOf(request("ui-1")), listOf(request("ui-1"), request("ui-2")), "会话",
        )
        assertEquals("ui-2", alert?.request?.id)
    }

    @Test fun onlyConfirmCanBeAnsweredFromTheShade() {
        assertEquals(listOf("允许", "拒绝"), approvalActions(LiveAlert(LiveAlertKind.NEEDS_INPUT, "b", "p", "t", "x", request())).map { it.label })
        assertEquals(listOf("true", "false"), approvalActions(LiveAlert(LiveAlertKind.NEEDS_INPUT, "b", "p", "t", "x", request())).map { it.value })
        // Sudo needs a password and free-text prompts need typing, so they only open the app.
        assertTrue(approvalActions(LiveAlert(LiveAlertKind.NEEDS_INPUT, "b", "p", "t", "x", request(method = "sudo"))).isEmpty())
        assertTrue(approvalActions(LiveAlert(LiveAlertKind.NEEDS_INPUT, "b", "p", "t", "x", request(method = "input"))).isEmpty())
        assertTrue(approvalActions(LiveAlert(LiveAlertKind.COMPLETED, "b", "p", "t", "x")).isEmpty())
    }

    @Test fun aSudoRequestDoesNotPretendToBeARegularConfirm() {
        val alert = findLiveAlert("b1", "p1", summary(), summary(), emptyList(), listOf(request(method = "sudo")), "会话")!!
        assertTrue(alert.text.contains("sudo"))
        assertTrue(approvalActions(alert).isEmpty())
    }

    @Test fun theFirstSightingOfASessionDoesNotNotify() {
        assertNull(findLiveAlert("b1", "p1", null, summary(status = "idle"), emptyList(), emptyList(), "会话"))
    }

    @Test fun theAlertKeepsItsBackendForDeepLinks() {
        val alert = findLiveAlert("b1", "p1", summary(status = "running"), summary(status = "idle"), emptyList(), emptyList(), "会话")!!
        assertEquals("b1", alert.backendId)
        assertEquals("p1", alert.sessionKey)
        assertNull(alert.request)
    }

    @Test fun titlesAreCappedForTheShade() {
        val long = "x".repeat(200)
        assertEquals(60, notificationTitle(long).length)
        assertTrue(notificationTitle(long).endsWith("…"))
        assertEquals("short", notificationTitle("short"))
    }
}
