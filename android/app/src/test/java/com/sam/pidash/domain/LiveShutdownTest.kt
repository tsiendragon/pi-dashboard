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

    @Test fun `clear requires the extension capability, not shutdown`() {
        val clearable = supported.copy(capabilities = listOf("session_clear"))
        assertTrue(clearable.canClear)
        assertFalse(clearable.canShutdown)
        assertFalse(supported.canClear)
    }

    @Test fun `clear stays available while working, but not while reconnecting or in rpc mode`() {
        val clearable = supported.copy(capabilities = listOf("session_clear"), status = "running")
        assertTrue(clearable.canClear)
        assertFalse(clearable.copy(status = "reconnecting").canClear)
        assertFalse(clearable.copy(mode = "rpc").canClear)
    }
}
