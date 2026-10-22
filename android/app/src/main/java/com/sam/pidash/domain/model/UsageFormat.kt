package com.sam.pidash.domain.model

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
fun cacheHitPercent(total: LiveUsageTotals): Int {
    val prompt = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens
    if (prompt <= 0) return 0
    return ((total.cacheReadTokens * 100.0) / prompt).toInt().coerceIn(0, 100)
}

fun topModels(report: LiveUsageReport, limit: Int = 5): List<LiveUsageModel> =
    report.models.sortedByDescending { it.costUsd }.take(limit)

fun topSessions(report: LiveUsageReport, limit: Int = 5): List<LiveUsageSession> =
    report.sessions.sortedByDescending { it.costUsd }.take(limit)

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
