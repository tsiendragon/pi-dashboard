package com.sam.pidash.data.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptPathsTest {
    @Test fun acceptsOnlyPlainWebLinks() {
        assertTrue(externalUrlAllowed("https://example.test/docs?x=1"))
        assertTrue(externalUrlAllowed("http://example.test"))
        assertFalse(externalUrlAllowed("javascript:alert(1)"))
        assertFalse(externalUrlAllowed("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(externalUrlAllowed("file:///etc/passwd"))
        assertFalse(externalUrlAllowed("https://example.test/a b"))
        assertFalse(externalUrlAllowed("https://example.test/\nInjected: x"))
        assertFalse(externalUrlAllowed("https://"))
    }
}
