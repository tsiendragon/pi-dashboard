package com.sam.pidash.domain.model

import java.text.NumberFormat
import java.util.Locale

data class ContextUsageDisplay(val percent: String?, val counts: String, val progress: Float?, val high: Boolean)

/** These are the latest context estimates, not accumulated input/output billing tokens. */
fun contextUsageDisplay(usage: LiveContextUsage?): ContextUsageDisplay {
    val tokens = usage?.tokens?.takeIf { it >= 0 }
    val window = usage?.contextWindow?.takeIf { it > 0 }
    val percent = usage?.percent?.takeIf { it.isFinite() && it >= 0 }
        ?: if (tokens != null && window != null) tokens.toDouble() / window * 100 else null
    val numbers = NumberFormat.getIntegerInstance(Locale.ROOT)
    val counts = when {
        tokens != null && window != null -> "${numbers.format(tokens)} / ${numbers.format(window)} tokens"
        tokens != null -> "${numbers.format(tokens)} tokens · 窗口未上报"
        window != null -> "tokens 未上报 / 窗口 ${numbers.format(window)}"
        else -> "tokens 与窗口尚未上报"
    }
    return ContextUsageDisplay(
        percent?.let { String.format(Locale.ROOT, "%.1f%%", it) }, counts,
        percent?.div(100)?.coerceIn(0.0, 1.0)?.toFloat(), (percent ?: 0.0) >= 85,
    )
}
