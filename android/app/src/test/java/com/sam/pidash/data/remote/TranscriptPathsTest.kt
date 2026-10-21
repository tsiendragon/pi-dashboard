package com.sam.pidash.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptPathsTest {
    private val transcript = """已修改 /home/tsien/apps/pi-dashboard/backend/routes/files.ts 和 docs/system.md"""

    @Test fun visiblePathsAreOpenable() {
        assertTrue(pathVisibleInTranscript(transcript, "/home/tsien/apps/pi-dashboard/backend/routes/files.ts"))
        assertTrue(pathVisibleInTranscript(transcript, "docs/system.md"))
    }

    @Test fun pathsNeverShownInTheTranscriptAreRefused() {
        assertFalse(pathVisibleInTranscript(transcript, "/etc/shadow"))
        assertFalse(pathVisibleInTranscript(transcript, "/home/tsien/.pi/agent/run/pi-dashboard/live-control-token"))
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

    @Test fun onlyHttpLinksLeaveTheApp() {
        assertTrue(externalUrlAllowed("https://example.test/docs?x=1"))
        assertTrue(externalUrlAllowed("http://example.test"))
        assertFalse(externalUrlAllowed("javascript:alert(1)"))
        assertFalse(externalUrlAllowed("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(externalUrlAllowed("file:///etc/passwd"))
        assertFalse(externalUrlAllowed("https://example.test/a b"))
        assertFalse(externalUrlAllowed("https://example.test/\nInjected: x"))
    }
}
