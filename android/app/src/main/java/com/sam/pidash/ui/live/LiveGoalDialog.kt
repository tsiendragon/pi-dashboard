package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveGoalAnchor
import com.sam.pidash.domain.model.blockerKindLabel
import com.sam.pidash.domain.model.blockerOwnerLabel
import com.sam.pidash.domain.model.goalSummary
import com.sam.pidash.domain.model.workItemGlyph
import com.sam.pidash.domain.model.workItemLabel

/**
 * Read-only goal anchor: objective, checklist progress, blockers and staleness.
 * Editing stays with the agent's `/goal` command — this dialog can only hand the
 * composer a `/goal ` prefix, never invent a goal.
 */
@Composable
internal fun LiveGoalDialog(
    goal: LiveGoalAnchor,
    onDismiss: () -> Unit,
    onEditWithCommand: () -> Unit,
) {
    val summary = goalSummary(goal) ?: return
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("目标", style = MaterialTheme.typography.titleSmall)
                Text(
                    "${summary.statusLabel} · ${summary.done}/${summary.total} 项已完成" +
                        if (summary.needsUser > 0) " · 待你决定 ${summary.needsUser}" else "",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(
                Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(goal.objective, style = MaterialTheme.typography.bodyMedium)
                if (summary.total > 0) {
                    LinearProgressIndicator(
                        progress = { summary.percent / 100f },
                        modifier = Modifier.fillMaxWidth().height(6.dp),
                    )
                }
                if (summary.stale != null) Text(
                    summary.staleMessage,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
                goal.progress.current?.takeIf { it.isNotBlank() }?.let {
                    Text("当前：$it", style = MaterialTheme.typography.bodySmall)
                }
                if (goal.workItems.isNotEmpty()) {
                    Text("工作项", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    goal.workItems.forEach { item ->
                        Row {
                            Text(
                                "${workItemGlyph(item.state)} ${workItemLabel(item.state)}",
                                style = MaterialTheme.typography.labelSmall,
                                color = when (item.state) {
                                    "done" -> MaterialTheme.colorScheme.tertiary
                                    "blocked" -> MaterialTheme.colorScheme.error
                                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                                },
                            )
                            Text("  ${item.title}", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                if (goal.blockers.isNotEmpty()) {
                    Text("阻塞", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    goal.blockers.forEach { blocker ->
                        Column(
                            Modifier.fillMaxWidth()
                                .padding(vertical = 2.dp),
                        ) {
                            Text(
                                "${blockerKindLabel(blocker.kind)} · ${blockerOwnerLabel(blocker.owner)} · ${blocker.title}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                            blocker.reason?.takeIf { it.isNotBlank() }?.let {
                                Text(it, style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                goal.progress.lastSummary?.takeIf { it.isNotBlank() }?.let {
                    Text("最近进展：$it", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        confirmButton = { TextButton(onClick = onEditWithCommand) { Text("用 /goal 修改") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
