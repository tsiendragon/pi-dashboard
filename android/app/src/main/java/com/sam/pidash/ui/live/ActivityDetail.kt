package com.sam.pidash.ui.live

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.common.Collapsible
import com.sam.pidash.ui.common.ExpandHint
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
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
    val toolCount = remember(activity.items) {
        activity.items.count { it.toolName != null || it.role == "tool" || it.toolCallId != null }
    }
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
                // Same rhythm as the session header: back button, two-line title block, status pill.
                Row(
                    Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
                        .padding(start = 4.dp, end = Spacing.md, top = 4.dp, bottom = 6.dp),
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
                            overflow = TextOverflow.Ellipsis,
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            StatusDot(
                                if (status.running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                                size = 6.dp,
                            )
                            Text(
                                listOfNotNull(
                                    "${activity.items.size} 条记录".takeIf { activity.items.isNotEmpty() },
                                    "$toolCount 步操作".takeIf { toolCount > 0 },
                                ).joinToString(" · ").ifBlank { "暂无记录" },
                                style = PiType.caption,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    ActivityStatusPill(status, Modifier.padding(start = Spacing.sm))
                }
                HorizontalDivider(thickness = Hairline, color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(start = Spacing.md, end = Spacing.md, top = Spacing.xs, bottom = endClearance),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    fun expandedFor(row: ActivityDetailRow.Trace) = expandedTraces[row.id] ?: (row.items.size <= 6)
                    fun toggle(row: ActivityDetailRow.Trace) { expandedTraces[row.id] = !expandedFor(row) }
                    rows.forEach { row ->
                        when (row) {
                            is ActivityDetailRow.Message -> item(key = row.id) {
                                NativeTimelineRow(
                                    TranscriptRow.Single(row.item), onOpenPath, onOpenUrl, onFork, enabled,
                                    onQuote, onAnnotate, compactUser = true, compactAssistant = true, expandedByDefault = true,
                                )
                            }
                            is ActivityDetailRow.Trace -> item(key = row.id) {
                                DetailTraceBlock(
                                    row = row,
                                    expanded = expandedFor(row),
                                    onToggle = { toggle(row) },
                                    onOpenPath = onOpenPath,
                                    onOpenUrl = onOpenUrl,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * A group of consecutive steps, drawn exactly like the card's 「执行步骤」 block so the
 * detail page and the feed read as one product: tinted box, hairline border, header pill.
 */
@Composable
private fun DetailTraceBlock(
    row: ActivityDetailRow.Trace,
    expanded: Boolean,
    onToggle: () -> Unit,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val counts = listOfNotNull(
        "${row.toolCount} 步".takeIf { row.toolCount > 0 },
        "${row.thinkingCount} 段思考".takeIf { row.thinkingCount > 0 },
    ).joinToString(" · ")
    val states = listOfNotNull(
        "${row.failedCount} 失败".takeIf { row.failedCount > 0 },
        "${row.runningCount} 进行中".takeIf { row.runningCount > 0 },
        "${row.unknownCount} 状态未确认".takeIf { row.unknownCount > 0 },
    ).joinToString(" · ")
    val failed = row.failedCount > 0

    Column(
        Modifier.fillMaxWidth()
            .background(scheme.surfaceVariant.copy(alpha = 0.45f), RoundedCornerShape(8.dp))
            .border(1.dp, scheme.outline.copy(alpha = 0.35f), RoundedCornerShape(8.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .clickable(onClick = onToggle)
                .heightIn(min = 48.dp)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                "执行记录",
                style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                color = scheme.onSurface,
            )
            Surface(
                color = if (failed) scheme.errorContainer else scheme.surface,
                shape = RoundedCornerShape(99.dp),
            ) {
                Text(
                    counts,
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp),
                    style = PiType.monoMicro,
                    color = if (failed) scheme.onErrorContainer else scheme.onSurfaceVariant,
                )
            }
            if (states.isNotEmpty()) Text(
                states,
                style = PiType.caption,
                color = if (failed) scheme.error else scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            ) else Spacer(Modifier.weight(1f))
            ExpandHint(expanded)
        }
        Collapsible(visible = expanded) {
            Column(Modifier.fillMaxWidth()) {
                HorizontalDivider(color = scheme.outline.copy(alpha = 0.2f))
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    row.items.forEach { entry ->
                        if (isDetailTool(entry)) NativeStepCard(entry, onOpenPath, onOpenUrl, showArguments = true)
                        else NativeMessageCard(entry, onOpenPath, onOpenUrl, compactAssistant = true)
                    }
                }
            }
        }
    }
}

