package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.common.CopyTextAction
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.codeTextStyle
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val MAX_VISIBLE_CHARS = 65_536

@Composable
internal fun ExecutionStepDialog(item: LiveTimelineItem, onDismiss: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val failed = item.isError || item.status == "error"
    val status = when {
        failed -> "失败"
        item.status == "running" -> "执行中"
        item.status == "done" -> "已完成"
        else -> "未确认"
    }
    val args = item.toolArgs.orEmpty()
    val command = remember(args) {
        (toolArgumentsObject(args)?.get("command") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    }
    val output = if (toolOutput(item).isNotEmpty()) item.text else ""
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = Radii.sheet,
        title = { Text(item.toolName ?: "步骤详情", maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            SelectionContainer {
                Column(
                    modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("执行状态：$status", style = PiType.footnote, color = if (failed) scheme.error else scheme.onSurfaceVariant)
                    command?.let { StepText("命令", it, "复制命令") }
                    if (args.isNotBlank()) StepText("参数", args, "复制参数")
                    if (command == null && args.isBlank()) Text("没有记录命令或参数。", style = PiType.footnote)
                    if (output.isNotEmpty()) StepText("输出", output, "复制输出")
                    else if (item.images.isEmpty()) {
                        Text(if (item.status == "running") "暂未收到输出。" else "没有记录输出。", style = PiType.footnote)
                    }
                    item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StepText(title: String, text: String, copyLabel: String) {
    val colors = MaterialTheme.colorScheme
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = PiType.footnote, color = colors.onSurfaceVariant)
            CopyTextAction(text, copyLabel)
        }
        Text(
            text.take(MAX_VISIBLE_CHARS),
            Modifier.fillMaxWidth().background(colors.surfaceVariant, Radii.chip).padding(8.dp),
            style = codeTextStyle(PiType.mono),
            color = colors.onSurfaceVariant,
        )
        if (text.length > MAX_VISIBLE_CHARS) Text("仅截断显示；可复制已接收的原文。", style = PiType.caption)
    }
}
