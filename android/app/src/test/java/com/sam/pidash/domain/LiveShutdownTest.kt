package com.sam.pidash.domain

import com.sam.pidash.domain.model.LiveSummary
import org.junit.Assert.*
import org.junit.Test

class LiveShutdownTest {
    private val supported = LiveSummary("process", "session", cwd = "/project", capabilities = listOf("session_shutdown"))

    @Test fun `idle and working TUI sessions can shut down`() {
        assertTrue(supported.canShutdown)
        assertTrue(supported.copy(status = "running").canShutdown)
    }

    @Test fun `legacy extensions cannot shut down`() {
        assertFalse(supported.copy(capabilities = emptyList()).canShutdown)
    }

    @Test fun `reconnecting and non TUI sessions cannot shut down`() {
        assertFalse(supported.copy(status = "reconnecting").canShutdown)
        assertFalse(supported.copy(mode = "rpc").canShutdown)
    }

    @Test fun `shutdown is shared and does not require stealing control`() {
        assertTrue(supported.copy(claim = com.sam.pidash.domain.model.LiveClaim(state = "claimed")).canShutdown)
    }
}
