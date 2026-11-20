package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveGoalAnchor
import com.sam.pidash.domain.model.blockerKindLabel
import com.sam.pidash.domain.model.blockerOwnerLabel
import com.sam.pidash.domain.model.goalSummary
import com.sam.pidash.domain.model.workItemGlyph
import com.sam.pidash.domain.model.workItemLabel
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Tints

/**
 * Goal anchor: objective, checklist progress, blockers and staleness.
 *
 * Structural edits still belong to the agent's `/goal` command, but pausing,
 * resuming and clearing are extension commands too: the dialog sends them as
 * shared input, with an explicit confirmation before the destructive clear.
 */
@Composable
internal fun LiveGoalDialog(
    goal: LiveGoalAnchor,
    busy: Boolean = false,
    onDismiss: () -> Unit,
    onEditWithCommand: () -> Unit,
    onPause: (() -> Unit)? = null,
    onResume: (() -> Unit)? = null,
    onClear: (() -> Unit)? = null,
) {
    var confirmClear by remember(goal.objective) { mutableStateOf(false) }
    if (confirmClear) {
        AlertDialog(shape = Radii.sheet,
            onDismissRequest = { if (!busy) confirmClear = false },
            title = { Text("清理目标？", style = PiType.callout) },
            text = {
                Text(
                    "当前目标、工作项和阻塞项会从这条会话中移除；历史对话不会被删除。请求会在当前回合结束后执行，且不能从 App 撤销。",
                    style = PiType.subhead,
                )
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    confirmClear = false
                    onClear?.invoke()
                }) { Text("清理", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { confirmClear = false }) { Text("取消") }
            },
        )
        return
    }
    val summary = goalSummary(goal) ?: return
    AlertDialog(shape = Radii.sheet,
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("目标", style = PiType.callout)
                Text(
                    "${summary.statusLabel} · ${summary.done}/${summary.total} 项已完成" +
                        if (summary.needsUser > 0) " · 待你决定 ${summary.needsUser}" else "",
                    style = PiType.action,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column {
                Column(
                    Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(goal.objective, style = PiType.callout)
                    if (summary.total > 0) {
                        LinearProgressIndicator(
                            progress = { summary.percent / 100f },
                            modifier = Modifier.fillMaxWidth().height(6.dp),
                        )
                    }
                    if (summary.stale != null) Text(
                        summary.staleMessage,
                        style = PiType.action,
                        color = MaterialTheme.colorScheme.error,
                    )
                    goal.progress.current?.takeIf { it.isNotBlank() }?.let {
                        Text("当前：$it", style = PiType.subhead)
                    }
                    if (goal.workItems.isNotEmpty()) {
                        Text("工作项", style = PiType.action,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        goal.workItems.forEach { item ->
                            Row {
                                Text(
                                    "${workItemGlyph(item.state)} ${workItemLabel(item.state)}",
                                    style = PiType.action,
                                    color = when (item.state) {
                                        "done" -> MaterialTheme.colorScheme.tertiary
                                        "blocked" -> MaterialTheme.colorScheme.error
                                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                )
                                Text("  ${item.title}", style = PiType.subhead)
                            }
                        }
                    }
                    if (goal.blockers.isNotEmpty()) {
                        Text("阻塞", style = PiType.action,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        goal.blockers.forEach { blocker ->
                            Column(
                                Modifier.fillMaxWidth()
                                    .padding(vertical = 2.dp),
                            ) {
                                Text(
                                    "${blockerKindLabel(blocker.kind)} · ${blockerOwnerLabel(blocker.owner)} · ${blocker.title}",
                                    style = PiType.subhead,
                                    color = MaterialTheme.colorScheme.error,
                                )
                                blocker.reason?.takeIf { it.isNotBlank() }?.let {
                                    Text(it, style = PiType.action,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                    goal.progress.lastSummary?.takeIf { it.isNotBlank() }?.let {
                        Text("最近进展：$it", style = PiType.subhead,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
                if (onPause != null || onResume != null || onClear != null) {
                    HorizontalDivider(
                        Modifier.padding(top = 8.dp),
                        color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline),
                    )
                    Row(
                        Modifier.fillMaxWidth().padding(top = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (goal.status == "paused" && onResume != null) OutlinedButton(
                            enabled = !busy,
                            onClick = onResume,
                            modifier = Modifier.weight(1f),
                        ) { Text("恢复目标", style = PiType.action) }
                        else if (goal.status == "active" && onPause != null) OutlinedButton(
                            enabled = !busy,
                            onClick = onPause,
                            modifier = Modifier.weight(1f),
                        ) { Text("暂停目标", style = PiType.action) }
                        if (onClear != null) OutlinedButton(
                            enabled = !busy,
                            onClick = { confirmClear = true },
                            modifier = Modifier.weight(1f),
                        ) { Text("清理目标", style = PiType.action) }
                    }
                    Text(
                        "命令会在当前回合结束后生效",
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onEditWithCommand) { Text("用 /goal 修改") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
