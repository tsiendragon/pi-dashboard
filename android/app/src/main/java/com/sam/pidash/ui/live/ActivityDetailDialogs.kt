package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.common.CopyTextAction
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints
import com.sam.pidash.ui.theme.codeTextStyle
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

private const val DETAIL_DISPLAY_LIMIT = 65_536

private fun detailText(value: String): String =
    if (value.length > DETAIL_DISPLAY_LIMIT) {
        value.take(DETAIL_DISPLAY_LIMIT) + "\n（展示已截断；复制会保留完整原文）"
    } else value

private fun toolArgsObject(item: LiveTimelineItem): JsonObject? {
    val raw = item.toolArgs?.trim().orEmpty()
    if (!raw.startsWith("{")) return null
    return runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull()
}

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

private fun toolOutputText(item: LiveTimelineItem): String =
    item.text.trim().takeIf { it.isNotEmpty() && it != "已完成" && it != "执行中…" }.orEmpty()

private fun toolStatusText(item: LiveTimelineItem): String? = when {
    item.isError || item.status == "error" -> "失败"
    item.status == "running" -> "进行中"
    item.status != "done" -> "状态未确认"
    else -> null
}

/**
 * One tool call in a short, scrollable surface. The activity card keeps only a
 * one-line summary; the exact command and output live here so expanding a long
 * turn can never stretch the feed into a wall of text.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun StepDetailDialog(
    item: LiveTimelineItem,
    onDismiss: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val parsed = toolArgsObject(item)
    val rawArgs = item.toolArgs?.trim().orEmpty()
    val command = parsed?.text("command")
    val description = parsed?.text("description")
    val output = toolOutputText(item)
    val status = toolStatusText(item)
    val name = item.toolName?.takeIf { it.isNotBlank() } ?: "工具"
    val otherArgs = if (command != null) {
        // Preserve fields such as timeout/cwd without turning the whole card into JSON.
        parsed?.entries?.filter { it.key !in setOf("command", "description") }
            ?.takeIf { it.isNotEmpty() }
            ?.joinToString("\n") { (key, value) ->
                "$key=${(value as? JsonPrimitive)?.contentOrNull ?: value}"
            }
    } else null

    DetailShell(
        title = "步骤详情",
        subtitle = listOfNotNull(name, status).joinToString(" · "),
        onDismiss = onDismiss,
    ) {
        if (status != null) {
            Text(
                "执行状态：$status",
                style = PiType.footnote,
                color = if (item.isError || item.status == "error") scheme.error else scheme.onSurfaceVariant,
            )
        }
        if (description != null) DetailSection("说明", description, code = false)
        if (command != null) DetailSection("命令", command) else if (rawArgs.isNotBlank()) {
            DetailSection("参数", rawArgs)
        }
        if (otherArgs != null) DetailSection("其他参数", otherArgs)
        if (output.isNotBlank()) DetailSection("输出", output)
        if (command == null && rawArgs.isBlank() && output.isBlank()) {
            Text("没有可显示的命令或输出。", style = PiType.footnote, color = scheme.onSurfaceVariant)
        }
        FlowRow(
            Modifier.fillMaxWidth().padding(top = Spacing.sm),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            if (command != null) CopyTextAction(command, "复制命令")
            if (rawArgs.isNotBlank()) CopyTextAction(rawArgs, "复制参数")
            if (output.isNotBlank()) CopyTextAction(output, "复制输出")
        }
    }
}

/** Full thinking text for the selected one-line thinking row. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ThinkingDetailDialog(text: String, onDismiss: () -> Unit) {
    DetailShell(
        title = "思考详情",
        subtitle = null,
        onDismiss = onDismiss,
    ) {
        SelectionContainer {
            Text(
                text,
                style = codeTextStyle(PiType.mono),
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        FlowRow(
            Modifier.fillMaxWidth().padding(top = Spacing.sm),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            CopyTextAction(text, "复制思考")
        }
    }
}

@Composable
private fun DetailShell(
    title: String,
    subtitle: String?,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            shape = Radii.sheet,
            color = scheme.surface,
            tonalElevation = 6.dp,
        ) {
            Column(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = Spacing.lg, top = Spacing.sm, end = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(title, style = PiType.pageTitle)
                        if (subtitle != null) {
                            Text(
                                subtitle,
                                style = PiType.caption,
                                color = scheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                    IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Filled.Close, "关闭", Modifier.size(20.dp))
                    }
                }
                HorizontalDivider(color = scheme.outline.copy(alpha = Tints.Hairline))
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = Spacing.lg, vertical = Spacing.md),
                    verticalArrangement = Arrangement.spacedBy(Spacing.md),
                ) {
                    content()
                }
                HorizontalDivider(color = scheme.outline.copy(alpha = Tints.Hairline))
                TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End).padding(end = Spacing.sm)) {
                    Text("关闭")
                }
            }
        }
    }
}

@Composable
private fun DetailSection(label: String, text: String, code: Boolean = true) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text(label, style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer {
            Text(
                detailText(text),
                style = if (code) codeTextStyle(PiType.mono) else PiType.subhead,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}