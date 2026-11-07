package com.sam.pidash.domain.model

import org.junit.Assert.*
import org.junit.Test

class ContextUsageDisplayTest {
    @Test fun unknownIsNotZero() {
        val display = contextUsageDisplay(null)
        assertNull(display.percent)
        assertNull(display.progress)
        assertTrue(display.counts.contains("尚未上报"))
    }
    @Test fun actualZeroIsShownAsZero() {
        val display = contextUsageDisplay(LiveContextUsage(0, 1000, 0.0))
        assertEquals("0.0%", display.percent)
        assertEquals("0 / 1,000 tokens", display.counts)
    }
    @Test fun fullTokenCountsAreNotRoundedToK() {
        val display = contextUsageDisplay(LiveContextUsage(123456, 1000000, 12.3456))
        assertEquals("123,456 / 1,000,000 tokens", display.counts)
        assertEquals("12.3%", display.percent)
    }
    @Test fun missingPercentCanBeDerivedOnlyFromKnownCounts() {
        assertEquals("50.0%", contextUsageDisplay(LiveContextUsage(50, 100, null)).percent)
        val missing = contextUsageDisplay(LiveContextUsage(null, 100, null))
        assertNull(missing.percent)
        assertTrue(missing.counts.contains("tokens 未上报"))
    }
    @Test fun overflowStaysVisibleButProgressIsBounded() {
        val display = contextUsageDisplay(LiveContextUsage(150, 100, 150.0))
        assertEquals("150.0%", display.percent)
        assertEquals(1f, display.progress!!, 0f)
        assertTrue(display.high)
    }
    @Test fun invalidNumbersDoNotInventUsage() {
        val display = contextUsageDisplay(LiveContextUsage(-1, 0, Double.NaN))
        assertNull(display.percent)
        assertNull(display.progress)
        assertFalse(display.high)
    }
}
