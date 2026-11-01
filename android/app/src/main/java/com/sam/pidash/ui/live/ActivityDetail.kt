package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.domain.model.ActivityDetailRow
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.activityStatus
import com.sam.pidash.domain.model.groupActivityDetail
import com.sam.pidash.domain.model.isDetailTool
import com.sam.pidash.domain.model.TranscriptRow
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

/**
 * Full record for one turn: every step, its arguments, its output and the thinking.
 * Opened from a card, so the reading surface stays clean until asked.
 */
@Composable
internal fun ActivityDetailDialog(
    activity: LiveActivity,
    enabled: Boolean,
    onDismiss: () -> Unit,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onQuote: (LiveTimelineItem) -> Unit,
    onAnnotate: (LiveTimelineItem) -> Unit,
    onFork: (String) -> Unit,
) {
    val status = activityStatus(activity)
    val rows = remember(activity.items) { groupActivityDetail(activity.items) }
    val expandedTraces = remember(activity.id) { mutableStateMapOf<String, Boolean>() }
    // Some fullscreen Dialog windows report consumed insets while extending below the screen.
    // This is scrollable end padding, not permanently reserved reading space.
    val endClearance = maxOf(64.dp, WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 24.dp)

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            // The list must be measured inside the visible area, not behind system bars.
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, end = Spacing.lg, top = 4.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", Modifier.size(20.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            "本轮记录",
                            style = PiType.callout.copy(fontWeight = FontWeight.SemiBold),
                            maxLines = 1,
                        )
                        MetaText(
                            listOfNotNull(status.label, "${activity.items.size} 条记录").joinToString("  ·  "),
                            tint = if (status.failed) MaterialTheme.colorScheme.error else null,
                        )
                    }
                    if (status.running) StatusDot(MaterialTheme.colorScheme.primary, size = 6.dp)
                }
                HorizontalDivider(thickness = Hairline, color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(start = Spacing.md, end = Spacing.md, top = Spacing.sm, bottom = endClearance),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    rows.forEach { row ->
                        when (row) {
                            is ActivityDetailRow.Message -> item(key = row.id) {
                                NativeTimelineRow(
                                    TranscriptRow.Single(row.item), onOpenPath, onOpenUrl, onFork, enabled,
                                    onQuote, onAnnotate, compactUser = true, compactAssistant = true, expandedByDefault = true,
                                )
                            }
                            is ActivityDetailRow.Trace -> {
                                val expanded = expandedTraces[row.id] == true
                                item(key = row.id) {
                                    DetailTraceHeader(row, expanded) { expandedTraces[row.id] = !expanded }
                                }
                                if (expanded) items(row.items, key = { "${row.id}:item:${it.id}" }) { entry ->
                                    Box(Modifier.fillMaxWidth().padding(start = Spacing.sm)) {
                                        if (isDetailTool(entry)) NativeStepCard(entry, onOpenPath, onOpenUrl, showArguments = true)
                                        else NativeMessageCard(entry, onOpenPath, onOpenUrl, compactAssistant = true)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailTraceHeader(row: ActivityDetailRow.Trace, expanded: Boolean, onToggle: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val counts = listOfNotNull(
        "${row.toolCount} 项工具".takeIf { row.toolCount > 0 },
        "${row.thinkingCount} 段思考".takeIf { row.thinkingCount > 0 },
    ).joinToString(" · ")
    val states = listOfNotNull(
        "${row.failedCount} 失败".takeIf { row.failedCount > 0 },
        "${row.runningCount} 进行中".takeIf { row.runningCount > 0 },
        "${row.unknownCount} 状态未确认".takeIf { row.unknownCount > 0 },
    ).joinToString(" · ")
    Row(
        Modifier.fillMaxWidth().clip(Radii.chip)
            .background(scheme.surfaceVariant.copy(alpha = 0.6f))
            .clickable(onClick = onToggle).heightIn(min = 48.dp)
            .padding(horizontal = Spacing.md, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(if (expanded) "⌃" else "⌄", style = PiType.footnote, color = scheme.onSurfaceVariant)
        Column(Modifier.weight(1f)) {
            Text(counts, style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold), color = scheme.onSurface)
            if (states.isNotEmpty()) Text(
                states, style = PiType.caption,
                color = if (row.failedCount > 0) scheme.error else scheme.onSurfaceVariant,
            )
        }
        Text(if (expanded) "收起" else "展开", style = PiType.caption, color = scheme.onSurfaceVariant)
    }
}
