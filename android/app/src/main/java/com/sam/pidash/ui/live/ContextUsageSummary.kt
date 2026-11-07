package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.*
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveContextUsage
import com.sam.pidash.domain.model.contextUsageDisplay
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing

@Composable
internal fun ContextUsageSummary(usage: LiveContextUsage?, cached: Boolean = false, connected: Boolean = true) {
    val display = contextUsageDisplay(usage)
    Column(Modifier.widthIn(min = 220.dp, max = 320.dp).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text("上下文 · ${display.percent ?: "占用待上报"}", style = PiType.rowTitle,
            color = if (display.high) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        Text(display.counts, style = PiType.footnote, color = MaterialTheme.colorScheme.onSurface)
        display.progress?.let { progress ->
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth(),
                color = if (display.high) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
        }
        Text(when {
            cached -> "本机缓存，非实时 · 非累计用量"
            !connected -> "最近上报，连接未同步 · 非累计用量"
            else -> "最近上报的估算值 · 非累计用量"
        }, style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
