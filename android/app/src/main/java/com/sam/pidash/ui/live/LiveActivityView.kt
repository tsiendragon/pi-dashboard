package com.sam.pidash.ui.live

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.LiveGoalAnchor

@Composable
internal fun LiveActivityCard(activity: LiveActivity, enabled: Boolean, onFork: (String) -> Unit) {
    var expanded by remember(activity.id) { mutableStateOf(false) }
    val tools = activity.items.filter { it.role == "tool" }
    val latest = activity.items.lastOrNull { it.role == "assistant" && it.text.isNotBlank() }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(activity.state, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
            Text(activity.title.take(180), style = MaterialTheme.typography.titleSmall, maxLines = 3)
            if (tools.isNotEmpty()) Text("工具步骤：${tools.count { it.status == "done" && !it.isError }} 已返回 · ${tools.count { it.status == "running" }} 执行中 · ${tools.count { it.isError }} 失败", style = MaterialTheme.typography.labelSmall)
            tools.takeLast(5).forEach { step ->
                Text("${when { step.isError -> "!"; step.status == "running" -> "◐"; else -> "✓" }} ${step.toolName ?: "tool"} · ${step.text.lineSequence().firstOrNull().orEmpty().take(120)}",
                    style = MaterialTheme.typography.bodySmall, color = if (step.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
            }
            latest?.let { SelectionContainer { Text(it.text.take(900) + if (it.text.length > 900) "\n（展开查看完整记录）" else "", style = MaterialTheme.typography.bodySmall) } }
            TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起完整记录" else "展开完整记录 / 分叉") }
            if (expanded) activity.items.forEach { LiveTimelineCard(it, enabled, onFork) }
        }
    }
}

@Composable
internal fun LiveGoalCard(goal: LiveGoalAnchor) {
    var expanded by remember(goal.objective) { mutableStateOf(false) }
    OutlinedCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clickable { expanded = !expanded }) {
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("目标（只读） · ${goal.status ?: "未标注"}", style = MaterialTheme.typography.labelMedium)
            Text(goal.objective, maxLines = if (expanded) 5 else 1, style = MaterialTheme.typography.bodySmall)
            if (goal.workItems.isNotEmpty()) Text("真实工作项：${goal.workItems.count { it.state == "done" }} / ${goal.workItems.size} 已标记完成", style = MaterialTheme.typography.labelSmall)
            goal.progress.current?.let { Text(it, maxLines = 2, style = MaterialTheme.typography.bodySmall) }
            if (goal.messagesSinceUpdate > 300 || goal.status == "complete" && goal.workItems.any { it.state != "done" })
                Text("目标记录可能落后于实际进度，请核对最新对话。", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            if (expanded) Column(Modifier.heightIn(max = 200.dp).verticalScroll(rememberScrollState())) {
                goal.progress.lastSummary?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                goal.workItems.forEach { Text("${it.state ?: "未标注"} · ${it.title}", style = MaterialTheme.typography.bodySmall) }
                goal.blockers.forEach { Text("阻塞：${it.title}${it.reason?.let { reason -> " · $reason" }.orEmpty()}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
