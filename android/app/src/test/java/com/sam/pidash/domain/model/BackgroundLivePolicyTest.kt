package com.sam.pidash.domain.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundLivePolicyTest {
    private fun summary(status: String) = LiveSummary(
        processInstanceId = "process",
        sessionId = "session",
        cwd = "/work",
        status = status,
    )

    private fun request() = LiveUiRequest(id = "request", method = "confirm", title = "继续？")

    @Test fun aRunningTurnKeepsTheSocketOpen() {
        assertTrue(shouldKeepLiveWatch(listOf(summary("running")), emptyList()))
    }

    @Test fun idleSessionsReleaseTheSocket() {
        assertFalse(shouldKeepLiveWatch(listOf(summary("idle")), emptyList()))
    }

    @Test fun aPendingRequestAlsoNeedsAttention() {
        assertTrue(shouldKeepLiveWatch(listOf(summary("idle")), listOf(request())))
    }
}
