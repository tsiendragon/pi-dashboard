package com.sam.pidash.ui.live

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.domain.model.LiveUsageModel
import com.sam.pidash.domain.model.LiveUsageReport
import com.sam.pidash.domain.model.cacheHitPercent
import com.sam.pidash.domain.model.dailyProjection
import com.sam.pidash.domain.model.dailySeries
import com.sam.pidash.domain.model.dailySummary
import com.sam.pidash.domain.model.humanTokens
import com.sam.pidash.domain.model.humanUsd
import com.sam.pidash.domain.model.modelDailySeries
import com.sam.pidash.domain.model.sqrtScale
import com.sam.pidash.domain.model.topModels
import com.sam.pidash.domain.model.topSessions
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints

@Composable
internal fun UsageDialog(
    report: LiveUsageReport?,
    month: String?,
    busy: Boolean,
    error: String?,
    onMonthChange: (Int) -> Unit,
    onDismiss: () -> Unit,
    title: String = "用量统计",
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(0.94f).fillMaxHeight(0.9f),
            shape = Radii.sheet,
        ) {
            Column(Modifier.padding(Spacing.md).verticalScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = PiType.callout, modifier = Modifier.weight(1f))
                    TextButton(enabled = !busy, onClick = { onMonthChange(-1) }) { Text("◀") }
                    Text(month?.takeIf { it.isNotBlank() } ?: "本月", style = PiType.action)
                    TextButton(enabled = !busy, onClick = { onMonthChange(1) }) { Text("▶") }
                }
                if (busy) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = Spacing.sm))
                    Text("读取中…", style = PiType.action)
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = PiType.subhead)
                }
                if (report == null && !busy && error == null) {
                    Text("暂无用量数据", style = PiType.subhead, modifier = Modifier.padding(vertical = Spacing.lg))
                }
                report?.let { UsageReportContent(it) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("关闭") }
                }
            }
        }
    }
}

@Composable
private fun UsageReportContent(report: LiveUsageReport) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        UsageSection("总览") {
            Text("本月已花 ${report.currency} ${humanUsd(report.total.costUsd)}", style = PiType.pageTitle)
            Text(
                "${humanTokens(report.total.totalTokens)} tokens · 缓存命中 ${cacheHitPercent(report.total)}% · ${report.recordCount} 条记录",
                style = PiType.subhead,
            )
            Text(
                "输入 ${humanTokens(report.total.inputTokens)} · 输出 ${humanTokens(report.total.outputTokens)} · " +
                    "缓存读 ${humanTokens(report.total.cacheReadTokens)} · 缓存写 ${humanTokens(report.total.cacheWriteTokens)}",
                style = PiType.action,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (report.timezone.isNotBlank()) {
                Text("时区 ${report.timezone}", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        dailyProjection(report, System.currentTimeMillis())?.let { projection ->
            UsageSection("月底预测") {
                Text(
                    "已花 ${report.currency} ${humanUsd(projection.spentUsd)}，预计月底 " +
                        "${report.currency} ${humanUsd(projection.projectedUsd)}（剩 ${projection.remainingDays} 天）",
                    style = PiType.subhead,
                )
                Text(
                    "按前 ${projection.elapsedDays} 个完整天线性外推，不含今天",
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        UsageSection("每日花费趋势") {
            val days = remember(report) { dailySeries(report) }
            if (days.isEmpty()) Text("本月暂无每日记录", style = PiType.subhead)
            else {
                val summary = remember(report) {
                    dailySummary(report, System.currentTimeMillis())
                }
                var selectedDate by remember(report.month, report.daily) {
                    mutableStateOf(summary?.peakDate ?: days.first().date)
                }
                if (summary != null) {
                    Text(
                        "最高 ${report.currency} ${humanUsd(summary.peakCost)} " +
                            "(${summary.peakDate.takeLast(5)}) · 日均 ${report.currency} " +
                            "${humanUsd(summary.averageCost)} · ${summary.activeDays} 天有花费",
                        style = PiType.footnote,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DailyUsageChart(
                    days = days,
                    selectedDate = selectedDate,
                    onSelect = { selectedDate = it },
                )
                days.find { it.date == selectedDate }?.let { day ->
                    Text(
                        "${day.date.takeLast(5)} · ${report.currency} ${humanUsd(day.costUsd)} · " +
                            "${humanTokens(day.totalTokens)} tokens · 缓存命中 ${cacheHitPercent(day)}%",
                        style = PiType.action,
                    )
                }
                DailyUsageDetails(days, report.currency)
            }
        }
        UsageSection("按模型") {
            val models = remember(report) { topModels(report, Int.MAX_VALUE) }
            if (models.isEmpty()) Text("本月暂无模型记录", style = PiType.subhead)
            else models.forEach { model -> ModelUsageRow(report, model) }
        }
        UsageSection("按会话 · 前 10") {
            val sessions = remember(report) { topSessions(report, 10) }
            if (sessions.isEmpty()) Text("本月暂无会话记录", style = PiType.subhead)
            else sessions.forEach { session ->
                Column(Modifier.fillMaxWidth().padding(vertical = Spacing.xs)) {
                    Text(
                        session.label.ifBlank { session.key.take(12) },
                        style = PiType.subhead,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "${report.currency} ${humanUsd(session.costUsd)} · ${humanTokens(session.totalTokens)} tokens · 缓存命中 ${cacheHitPercent(session)}%",
                        style = PiType.action,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun UsageSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Text(title, style = PiType.callout)
        Column(
            modifier = Modifier.fillMaxWidth().background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = Tints.Border),
                MaterialTheme.shapes.medium,
            ).padding(Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            content = content,
        )
    }
}

/** One canvas keeps the 30-day chart compact; taps use the full column width. */
@Composable
private fun DailyUsageChart(
    days: List<com.sam.pidash.domain.model.LiveUsageDay>,
    selectedDate: String,
    onSelect: (String) -> Unit,
) {
    val maxCost = days.maxOf { it.costUsd }.coerceAtLeast(0.0)
    val barColor = MaterialTheme.colorScheme.primary
    val selectedColor = MaterialTheme.colorScheme.tertiary
    val zeroColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f)
    val axisColor = MaterialTheme.colorScheme.outlineVariant
    val dayLabelColor = MaterialTheme.colorScheme.onSurfaceVariant
    val dayLabelStyle = PiType.footnote
    Column(Modifier.fillMaxWidth()) {
        Canvas(
            Modifier.fillMaxWidth().height(132.dp).pointerInput(days) {
                detectTapGestures { offset ->
                    if (days.isNotEmpty()) {
                        val index = (offset.x / size.width * days.size).toInt()
                            .coerceIn(0, days.lastIndex)
                        onSelect(days[index].date)
                    }
                }
            },
        ) {
            val baseline = size.height - 3.dp.toPx()
            val chartHeight = baseline - 4.dp.toPx()
            val slotWidth = size.width / days.size
            val barWidth = (slotWidth * 0.64f).coerceAtLeast(1.dp.toPx())
            drawLine(
                color = axisColor,
                start = Offset(0f, baseline),
                end = Offset(size.width, baseline),
                strokeWidth = 1.dp.toPx(),
            )
            days.forEachIndexed { index, day ->
                val fraction = sqrtScale(day.costUsd, maxCost)
                val barHeight = if (fraction > 0f) {
                    (chartHeight * fraction).coerceAtLeast(2.dp.toPx())
                } else 2.dp.toPx()
                val color = when {
                    day.date == selectedDate -> selectedColor
                    day.costUsd > 0.0 -> barColor
                    else -> zeroColor
                }
                drawRect(
                    color = color,
                    topLeft = Offset(index * slotWidth + (slotWidth - barWidth) / 2f, baseline - barHeight),
                    size = Size(barWidth, barHeight),
                )
            }
        }
        Row(Modifier.fillMaxWidth()) {
            days.forEachIndexed { index, day ->
                Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    if (index % 5 == 0 || index == days.lastIndex) {
                        Text(
                            day.date.takeLast(2),
                            style = dayLabelStyle,
                            color = dayLabelColor,
                            maxLines = 1,
                            softWrap = false,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DailyUsageDetails(days: List<com.sam.pidash.domain.model.LiveUsageDay>, currency: String) {
    var expanded by remember(days) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small)
                .clickable { expanded = !expanded }.padding(vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                contentDescription = if (expanded) "收起每日明细" else "展开每日明细",
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(Spacing.xs))
            Text("逐日明细", style = PiType.action)
        }
        if (expanded) {
            val maxCost = days.maxOf { it.costUsd }.coerceAtLeast(0.0)
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                days.forEach { day -> DailyUsageBar(day.date, day.costUsd, maxCost, currency) }
            }
        }
    }
}

@Composable
private fun DailyUsageBar(date: String, costUsd: Double, maxCost: Double, currency: String) {
    val fraction = if (maxCost > 0.0) (costUsd / maxCost).toFloat().coerceIn(0f, 1f) else 0f
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(date.takeLast(5), style = PiType.action, modifier = Modifier.width(44.dp))
        Box(
            Modifier.weight(1f).height(10.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        ) {
            if (fraction > 0f) {
                Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
            }
        }
        Spacer(Modifier.width(Spacing.sm))
        Text("$currency ${humanUsd(costUsd)}", style = PiType.action)
    }
}

@Composable
private fun ModelUsageRow(report: LiveUsageReport, model: LiveUsageModel) {
    var expanded by remember(report.month, model.key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small)
                .clickable { expanded = !expanded }.padding(vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                contentDescription = if (expanded) "收起每日小计" else "展开每日小计",
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(Spacing.xs))
            Column(Modifier.weight(1f)) {
                Text(model.key, style = PiType.subhead, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    "${report.currency} ${humanUsd(model.costUsd)} · ${humanTokens(model.totalTokens)} tokens · 缓存命中 ${cacheHitPercent(model)}%",
                    style = PiType.action,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (expanded) {
            val days = remember(report, model.key) { modelDailySeries(report, model.key) }
            Column(
                Modifier.fillMaxWidth().padding(start = Spacing.md),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                if (days.isEmpty()) Text("暂无每日小计", style = PiType.footnote)
                else days.forEach { day ->
                    Row(Modifier.fillMaxWidth()) {
                        Text(day.date, style = PiType.footnote, modifier = Modifier.weight(1f))
                        Text(
                            "${report.currency} ${humanUsd(day.model.costUsd)} · ${humanTokens(day.model.totalTokens)} tokens",
                            style = PiType.footnote,
                        )
                    }
                }
            }
        }
    }
}
