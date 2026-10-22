package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.canMoveToBackground
import com.sam.pidash.data.remote.elapsedSeconds
import com.sam.pidash.data.remote.isActive
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.domain.model.LiveBackgroundTask

/**
 * Background command panel, projected from the `background-commands` feature
 * snapshot. Read-only except for one action the Live protocol allows: moving a
 * still-running foreground call to the background (lease-bound).
 */
@Composable
internal fun BackgroundCommandsDialog(
    snapshot: LiveBackgroundSnapshot,
    selected: String?,
    busy: Boolean,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
    onMoveToBackground: (LiveBackgroundTask) -> Unit,
) {
    val tasks = snapshot.tasks
    val task = tasks.firstOrNull { it.taskId == selected } ?: tasks.lastOrNull()
    val active = tasks.count { it.isActive() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("后台命令", style = MaterialTheme.typography.titleSmall)
                Text(
                    "$active 个运行中 · 共 ${tasks.size} 个",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    tasks.forEach { item ->
                        val current = item.taskId == task?.taskId
                        Text(
                            item.title.ifBlank { item.taskId },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .background(
                                    if (current) MaterialTheme.colorScheme.primaryContainer
                                    else MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(6.dp),
                                )
                                .clickable { onSelect(item.taskId) }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
                if (task == null) {
                    Text("没有后台命令记录。", style = MaterialTheme.typography.bodySmall)
                    return@Column
                }
                Text(
                    "${task.taskId} · ${task.status}" +
                        " · ${task.elapsedSeconds(System.currentTimeMillis())}s" +
                        (task.pid?.let { " · pid $it" } ?: ""),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (task.command.isNotBlank()) Text(
                    task.command,
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    maxLines = 3,
                )
                val outcome = listOfNotNull(
                    task.exitCode?.let { "exit $it" },
                    task.exitReason,
                    task.error,
                ).joinToString(" · ")
                if (outcome.isNotBlank()) Text(
                    outcome,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (task.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (task.canMoveToBackground()) TextButton(
                    enabled = !busy,
                    onClick = { onMoveToBackground(task) },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                ) { Text("转入后台", style = MaterialTheme.typography.labelSmall) }
                Text(
                    if (task.outputTruncated) "输出（尾部，已截断）" else "输出（尾部）",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Column(
                    Modifier.fillMaxWidth().heightIn(max = 240.dp)
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
                        .padding(6.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    Text(
                        task.outputTail.ifBlank { "（还没有输出）" },
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    )
                }
                Text(
                    "取消需要网页端或扩展操作；App 只展示与转入后台。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
