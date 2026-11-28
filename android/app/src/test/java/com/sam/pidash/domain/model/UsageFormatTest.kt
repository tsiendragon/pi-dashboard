package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    private fun utcNow(value: String): Long = java.time.Instant.parse(value).toEpochMilli()

    private fun marchReport() = LiveUsageReport(
        month = "2026-03",
        timezone = "UTC",
        daily = listOf(
            LiveUsageDay(date = "2026-03-01", costUsd = 10.0),
            LiveUsageDay(date = "2026-03-02", costUsd = 20.0),
            LiveUsageDay(date = "2026-03-03", costUsd = 1000.0),
            LiveUsageDay(date = "2026-03-31", costUsd = 500.0),
        ),
    )

    @Test fun dailyProjectionUsesCompletedDaysForLinearForecast() {
        val projection = dailyProjection(marchReport(), utcNow("2026-03-03T23:59:00Z"))!!
        assertEquals(30.0, projection.spentUsd, 0.0001)
        assertEquals(465.0, projection.projectedUsd, 0.0001)
        assertEquals(2, projection.elapsedDays)
        assertEquals(31, projection.totalDays)
        assertEquals(28, projection.remainingDays)
    }

    @Test fun dailyProjectionExcludesTodayAndIgnoresTotalDoubleCounting() {
        val report = marchReport().copy(total = LiveUsageTotals(costUsd = 9999.0))
        val projection = dailyProjection(report, utcNow("2026-03-03T12:00:00Z"))!!
        assertEquals(30.0, projection.spentUsd, 0.0001)
        assertEquals(465.0, projection.projectedUsd, 0.0001)
    }

    @Test fun dailyProjectionIsUnavailableOnFirstDay() {
        assertNull(dailyProjection(marchReport(), utcNow("2026-03-01T23:00:00Z")))
    }

    @Test fun dailyProjectionIsUnavailableForHistoricalMonth() {
        assertNull(dailyProjection(marchReport(), utcNow("2026-04-03T12:00:00Z")))
    }

    @Test fun dailyProjectionUsesReportTimezoneForToday() {
        val report = marchReport().copy(timezone = "America/Los_Angeles")
        val projection = dailyProjection(report, utcNow("2026-03-03T07:00:00Z"))!!
        assertEquals(10.0, projection.spentUsd, 0.0001)
        assertEquals(1, projection.elapsedDays)
    }

    @Test fun sessionCacheHitUsesAllPromptTokenKinds() {
        val session = LiveUsageSession("s", inputTokens = 100, cacheReadTokens = 800, cacheWriteTokens = 100)
        assertEquals(80, cacheHitPercent(session))
        assertEquals(0, cacheHitPercent(LiveUsageSession("empty")))
    }

    @Test fun modelDailySeriesMatchesModelAndAggregatesDailyRows() {
        val report = marchReport().copy(daily = listOf(
            LiveUsageDay(date = "2026-03-02", models = listOf(
                LiveUsageModel(key = "a", costUsd = 2.0, totalTokens = 20),
                LiveUsageModel(key = "b", costUsd = 99.0, totalTokens = 99),
                LiveUsageModel(key = "a", costUsd = 3.0, totalTokens = 30),
            )),
            LiveUsageDay(date = "2026-03-01", models = listOf(
                LiveUsageModel(key = "a", costUsd = 1.0, totalTokens = 10),
            )),
        ))
        val result = modelDailySeries(report, "a")
        assertEquals(listOf("2026-03-01", "2026-03-02"), result.map { it.date })
        assertEquals(listOf(1.0, 5.0), result.map { it.model.costUsd })
        assertEquals(listOf(10L, 50L), result.map { it.model.totalTokens })
    }

    @Test fun sqrtScaleHandlesBoundariesAndClampsToUnitRange() {
        assertEquals(0f, sqrtScale(0.0, 100.0))
        assertEquals(1f, sqrtScale(100.0, 100.0))
        assertEquals(1f, sqrtScale(400.0, 100.0))
        assertEquals(0f, sqrtScale(100.0, 0.0))
    }

    @Test fun sqrtScaleIsMonotonic() {
        val small = sqrtScale(0.02, 40.78)
        val medium = sqrtScale(0.60, 40.78)
        val large = sqrtScale(40.78, 40.78)
        assertTrue(small < medium)
        assertTrue(medium < large)
    }

    @Test fun dailySummaryIdentifiesPeakAndActiveDays() {
        val summary = dailySummary(marchReport(), utcNow("2026-03-03T12:00:00Z"))!!
        assertEquals("2026-03-03", summary.peakDate)
        assertEquals(1000.0, summary.peakCost, 0.0001)
        assertEquals(4, summary.activeDays)
        assertEquals(31, summary.totalDays)
    }

    @Test fun dailySummaryUsesElapsedDaysNowAndFullMonthForHistory() {
        val current = dailySummary(marchReport(), utcNow("2026-03-03T12:00:00Z"))!!
        val historical = dailySummary(marchReport(), utcNow("2026-04-03T12:00:00Z"))!!
        assertEquals(1530.0 / 3, current.averageCost, 0.0001)
        assertEquals(1530.0 / 31, historical.averageCost, 0.0001)
        assertEquals(31, current.totalDays)
        assertEquals(31, historical.totalDays)
    }

    @Test fun dailySummaryReturnsNullWhenEveryDayIsZero() {
        val report = marchReport().copy(daily = listOf(
            LiveUsageDay(date = "2026-03-01", costUsd = 0.0),
            LiveUsageDay(date = "2026-03-02", costUsd = 0.0),
        ))
        assertNull(dailySummary(report, utcNow("2026-03-03T12:00:00Z")))
    }

    @Test fun dailySeriesKeepsZeroCostDaysAndDropsInvalidDates() {
        val report = marchReport().copy(daily = listOf(
            LiveUsageDay(date = "2026-03-02", costUsd = 2.0),
            LiveUsageDay(date = "not-a-date", costUsd = 100.0),
            LiveUsageDay(date = "2026-03-01", costUsd = 0.0),
        ))
        assertEquals(listOf("2026-03-01", "2026-03-02"), dailySeries(report).map { it.date })
    }
}
