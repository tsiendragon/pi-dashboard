package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.LiveSubagentWorkflow
import com.sam.pidash.data.remote.LiveWorkflowRecord
import com.sam.pidash.data.remote.liveWorkStatusLabel
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii

/**
 * Read-only view of the Workbench feature (`subagent-workflow`).
 *
 * The phone intentionally has no start/cancel controls: the Workbench owns those
 * jobs, and a stale live snapshot must never become a command surface.
 */
@Composable
internal fun SubagentWorkflowDialog(
    work: LiveSubagentWorkflow,
    stale: Boolean,
    onDismiss: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    AlertDialog(
        shape = Radii.sheet,
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("子 Agent / 工作流", style = PiType.callout)
                Text(
                    when {
                        stale -> "上次同步 · 只读"
                        work.summaryLabel != null -> work.summaryLabel!!
                        else -> "当前没有活动的子 Agent 或工作流"
                    },
                    style = PiType.action,
                    color = if (work.hasAttention && !stale) colors.error else colors.onSurfaceVariant,
                )
            }
        },
        text = {
            Column(
                Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                SectionTitle("子 Agent · ${work.agentsTotal}")
                if (work.agents.isEmpty()) {
                    Text(
                        if (work.agentsTotal > 0) "扩展未提供子 Agent 明细。" else "当前没有普通子 Agent 记录。",
                        style = PiType.caption,
                        color = colors.onSurfaceVariant,
                    )
                } else {
                    work.agents.forEach { agent ->
                        val tone = when {
                            agent.hasAttention -> colors.error
                            agent.isActive -> colors.primary
                            else -> colors.onSurfaceVariant
                        }
                        Column {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(agent.label, Modifier.weight(1f), style = PiType.caption, maxLines = 2)
                                Text(liveWorkStatusLabel(agent.status), style = PiType.caption, color = tone)
                            }
                            Text(
                                agent.id,
                                style = PiType.micro.copy(fontFamily = PiType.codeFamily),
                                color = colors.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                }

                SectionTitle("工作流 · ${work.workflowsTotal}")
                if (work.workflows.isEmpty()) {
                    Text(
                        if (work.workflowsTotal > 0) "扩展未提供工作流明细。" else "当前没有 Workflow 记录。",
                        style = PiType.caption,
                        color = colors.onSurfaceVariant,
                    )
                } else {
                    work.workflows.forEach { workflow -> WorkflowRow(workflow) }
                }

                Text(
                    "只读：启动、重试、暂停和审批仍在 Pi Workbench 中操作。",
                    style = PiType.caption,
                    color = colors.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = PiType.action, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun WorkflowRow(workflow: LiveWorkflowRecord) {
    val colors = MaterialTheme.colorScheme
    val tone = when {
        workflow.hasFailed || workflow.isPaused -> colors.error
        workflow.isActive -> colors.primary
        else -> colors.onSurfaceVariant
    }
    Column {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(workflow.label, Modifier.weight(1f), style = PiType.caption, maxLines = 2)
            Text(liveWorkStatusLabel(workflow.status), style = PiType.caption, color = tone)
        }
        val detail = listOfNotNull(workflow.id, workflow.progressLabel).joinToString(" · ")
        Text(
            detail,
            style = PiType.micro.copy(fontFamily = PiType.codeFamily),
            color = colors.onSurfaceVariant,
            maxLines = 2,
        )
    }
}
