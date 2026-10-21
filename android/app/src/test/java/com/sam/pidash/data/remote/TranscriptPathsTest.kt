package com.sam.pidash.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptPathsTest {
    private val transcript = """已修改 /home/you/apps/pi-dashboard/backend/routes/files.ts 和 docs/system.md"""

    @Test fun visiblePathsAreOpenable() {
        assertTrue(pathVisibleInTranscript(transcript, "/home/you/apps/pi-dashboard/backend/routes/files.ts"))
        assertTrue(pathVisibleInTranscript(transcript, "docs/system.md"))
    }

    @Test fun pathsNeverShownInTheTranscriptAreRefused() {
        assertFalse(pathVisibleInTranscript(transcript, "/etc/shadow"))
        assertFalse(pathVisibleInTranscript(transcript, "/home/you/.pi/agent/run/pi-dashboard/live-control-token"))
    }

    @Test fun urlsAndInjectionShapedValuesAreRefused() {
        assertFalse(pathVisibleInTranscript("see https://example.test/x", "https://example.test/x"))
        assertFalse(pathVisibleInTranscript("a\nb", "a\nb"))
        assertFalse(pathVisibleInTranscript("tab\there", "tab\there"))
        assertFalse(pathVisibleInTranscript("x".repeat(5000), "x".repeat(5000)))
        assertFalse(pathVisibleInTranscript(transcript, "   "))
    }

    @Test fun leadingDotSlashIsTolerated() {
        assertTrue(pathVisibleInTranscript("docs/system.md", "./docs/system.md"))
    }
}
