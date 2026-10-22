package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Test

class UsageFormatTest {
    @Test fun tokensAndDollarsAreShortened() {
        assertEquals("999", humanTokens(999))
        assertEquals("1.5K", humanTokens(1500))
        assertEquals("2.3M", humanTokens(2_345_678))
        assertEquals("$0.00", humanUsd(0.0))
        assertEquals("0.004", humanUsd(0.004))
        assertEquals("12.34", humanUsd(12.34))
        assertEquals("1234", humanUsd(1234.0))
    }

    @Test fun cacheHitIsShareOfPromptTokens() {
        val totals = LiveUsageTotals(inputTokens = 100, cacheReadTokens = 800, cacheWriteTokens = 100)
        assertEquals(80, cacheHitPercent(totals))
        assertEquals(0, cacheHitPercent(LiveUsageTotals()))
    }

    @Test fun modelsAndSessionsRankByCostAndCapTheList() {
        val report = LiveUsageReport(
            models = (1..7).map { LiveUsageModel(key = "m$it", costUsd = it.toDouble()) },
            sessions = listOf(
                LiveUsageSession("a", costUsd = 1.0),
                LiveUsageSession("b", costUsd = 9.0),
                LiveUsageSession("c", costUsd = 5.0),
            ),
        )
        assertEquals(listOf("m7", "m6", "m5", "m4", "m3"), topModels(report).map { it.key })
        assertEquals(listOf("b", "c", "a"), topSessions(report).map { it.key })
    }

    @Test fun monthShiftCrossesYearBoundaries() {
        assertEquals("2026-01", shiftMonth("2025-12", 1))
        assertEquals("2025-12", shiftMonth("2026-01", -1))
        assertEquals("2026-07", shiftMonth("2026-08", -1))
        assertEquals(null, shiftMonth("2026-8", 0))
        assertEquals(null, shiftMonth("bogus", 1))
    }
}
