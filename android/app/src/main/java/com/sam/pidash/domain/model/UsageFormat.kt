package com.sam.pidash.domain.model

import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import kotlin.math.sqrt

/**
 * Usage numbers as a phone dialog can show them. The `/api/usage` report is a
 * month of token and cost totals per model and per session; the pure helpers
 * here keep the formatting and ranking testable.
 */
fun humanTokens(tokens: Long): String = when {
    tokens >= 1_000_000 -> String.format("%.1fM", tokens / 1_000_000.0)
    tokens >= 1_000 -> String.format("%.1fK", tokens / 1_000.0)
    else -> tokens.toString()
}

fun humanUsd(amount: Double): String = when {
    amount <= 0.0 -> "$0.00"
    amount < 0.01 -> String.format("%.3f", amount)
    amount < 1000 -> String.format("%.2f", amount)
    else -> String.format("%.0f", amount)
}

/** Cache reads are the cheap path; the ratio explains why a big month stayed affordable. */
fun cacheHitPercent(total: LiveUsageTotals): Int = cacheHitPercent(
    total.inputTokens, total.cacheReadTokens, total.cacheWriteTokens,
)

fun cacheHitPercent(session: LiveUsageSession): Int = cacheHitPercent(
    session.inputTokens, session.cacheReadTokens, session.cacheWriteTokens,
)

fun cacheHitPercent(model: LiveUsageModel): Int = cacheHitPercent(
    model.inputTokens, model.cacheReadTokens, model.cacheWriteTokens,
)

fun cacheHitPercent(day: LiveUsageDay): Int = cacheHitPercent(
    day.inputTokens, day.cacheReadTokens, day.cacheWriteTokens,
)

private fun cacheHitPercent(input: Long, read: Long, write: Long): Int {
    val prompt = input + read + write
    if (prompt <= 0) return 0
    return ((read * 100.0) / prompt).toInt().coerceIn(0, 100)
}

fun topModels(report: LiveUsageReport, limit: Int = 5): List<LiveUsageModel> =
    report.models.sortedByDescending { it.costUsd }.take(limit)

fun topSessions(report: LiveUsageReport, limit: Int = 5): List<LiveUsageSession> =
    report.sessions.sortedByDescending { it.costUsd }.take(limit)

data class UsageProjection(
    val spentUsd: Double,
    val projectedUsd: Double,
    val elapsedDays: Int,
    val totalDays: Int,
    val remainingDays: Int,
)

/**
 * Linear forecast for the current month. Today is incomplete, so neither its
 * cost nor its day is included. Invalid reports and future/history months do
 * not produce a forecast. The report timezone defines the ledger's day boundary.
 */
fun dailyProjection(report: LiveUsageReport, now: Long): UsageProjection? {
    val month = runCatching { YearMonth.parse(report.month) }.getOrNull() ?: return null
    val zone = runCatching {
        if (report.timezone.isBlank()) ZoneId.systemDefault() else ZoneId.of(report.timezone)
    }.getOrNull() ?: return null
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    if (YearMonth.from(today) != month) return null
    val elapsedDays = today.dayOfMonth - 1
    if (elapsedDays <= 0) return null
    val firstDay = month.atDay(1)
    val spentUsd = report.daily.sumOf { day ->
        val date = runCatching { LocalDate.parse(day.date) }.getOrNull()
        if (date != null && date >= firstDay && date < today) day.costUsd else 0.0
    }
    val totalDays = month.lengthOfMonth()
    return UsageProjection(
        spentUsd = spentUsd,
        projectedUsd = spentUsd / elapsedDays * totalDays,
        elapsedDays = elapsedDays,
        totalDays = totalDays,
        remainingDays = totalDays - today.dayOfMonth,
    )
}

/** Compress extreme daily costs while preserving zero and clamping invalid ranges. */
fun sqrtScale(costUsd: Double, maxCost: Double): Float {
    if (costUsd <= 0.0 || maxCost <= 0.0) return 0f
    return (sqrt(costUsd) / sqrt(maxCost)).toFloat().coerceIn(0f, 1f)
}

data class UsageDailySummary(
    val peakDate: String,
    val peakCost: Double,
    val averageCost: Double,
    val activeDays: Int,
    val totalDays: Int,
)

/** Current months average over elapsed days; other months use their full length. */
fun dailySummary(report: LiveUsageReport, now: Long): UsageDailySummary? {
    val month = runCatching { YearMonth.parse(report.month) }.getOrNull() ?: return null
    val zone = runCatching {
        if (report.timezone.isBlank()) ZoneId.systemDefault() else ZoneId.of(report.timezone)
    }.getOrNull() ?: return null
    val days = dailySeries(report)
    val peak = days.maxByOrNull { it.costUsd }?.takeIf { it.costUsd > 0.0 } ?: return null
    val totalDays = month.lengthOfMonth()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val divisor = if (YearMonth.from(today) == month) today.dayOfMonth else totalDays
    return UsageDailySummary(
        peakDate = peak.date,
        peakCost = peak.costUsd,
        averageCost = days.sumOf { it.costUsd } / divisor,
        activeDays = days.count { it.costUsd > 0.0 },
        totalDays = totalDays,
    )
}

/** Keep every day so gaps are visible instead of making a sparse trend misleading. */
fun dailySeries(report: LiveUsageReport): List<LiveUsageDay> =
    report.daily.filter { runCatching { LocalDate.parse(it.date) }.isSuccess }.sortedBy { it.date }

/** Aggregate one model across days by stable key, preserving chronological order. */
data class UsageModelDay(val date: String, val model: LiveUsageModel)

fun modelDailySeries(report: LiveUsageReport, modelKey: String): List<UsageModelDay> =
    dailySeries(report).mapNotNull { day ->
        day.models.filter { it.key == modelKey }
            .takeIf { it.isNotEmpty() }
            ?.let { matches ->
                UsageModelDay(
                    date = day.date,
                    model = matches.reduce { total, model ->
                        total.copy(
                            inputTokens = total.inputTokens + model.inputTokens,
                            outputTokens = total.outputTokens + model.outputTokens,
                            cacheReadTokens = total.cacheReadTokens + model.cacheReadTokens,
                            cacheWriteTokens = total.cacheWriteTokens + model.cacheWriteTokens,
                            totalTokens = total.totalTokens + model.totalTokens,
                            costUsd = total.costUsd + model.costUsd,
                            inputCostUsd = total.inputCostUsd + model.inputCostUsd,
                            outputCostUsd = total.outputCostUsd + model.outputCostUsd,
                            cacheReadCostUsd = total.cacheReadCostUsd + model.cacheReadCostUsd,
                            cacheWriteCostUsd = total.cacheWriteCostUsd + model.cacheWriteCostUsd,
                            effectiveUsdPerMillionTokens = 0.0,
                            efforts = emptyList(),
                        )
                    },
                )
            }
    }

/** `2026-08` → `2026-07`; keeps the month inside the ledger's format. */
fun shiftMonth(month: String, delta: Int): String? {
    val match = Regex("^(\\d{4})-(\\d{2})$").find(month) ?: return null
    val year = match.groupValues[1].toInt()
    val index = match.groupValues[2].toInt() - 1 + delta
    val newYear = year + Math.floorDiv(index, 12)
    val newMonth = Math.floorMod(index, 12) + 1
    if (newYear < 2000 || newYear > 2999) return null
    return String.format("%04d-%02d", newYear, newMonth)
}
