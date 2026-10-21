package com.sam.pidash.ui.live

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.markdown.MarkdownBody

/**
 * Native transcript cards, mirroring the WebUI presentation rules:
 *
 * - a tool is one line (status · tool · detail); its output is collapsed until
 *   asked for, and `run_code` is grouped under "Run Code";
 * - a reply longer than 12 lines or 1200 characters is clipped with an explicit
 *   "展开全部正文（N 行）" affordance.
 */

/** Same thresholds as the WebUI's ActivityReplyBody. */
private const val PREVIEW_LINES = 12
private const val PREVIEW_CHARS = 1200

private data class StepStyle(val icon: String, val label: String, val color: androidx.compose.ui.graphics.Color)

@Composable
private fun stepStyle(item: LiveTimelineItem): StepStyle {
    val scheme = MaterialTheme.colorScheme
    return when {
        item.isError -> StepStyle("!", "失败", scheme.error)
        item.status == "running" -> StepStyle("●", "进行中", scheme.primary)
        else -> StepStyle("✓", "已完成", scheme.tertiary)
    }
}

private fun isToolItem(item: LiveTimelineItem) =
    item.role == "tool" || item.role == "toolResult" || item.toolName != null

private fun isRunCode(item: LiveTimelineItem) =
    item.toolName?.contains("run", true) == true && item.toolName?.contains("code", true) == true

@Composable
internal fun NativeStepCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val status = stepStyle(item)
    var open by remember(item.id) { mutableStateOf(false) }
    val body = item.text.trim()
    val lines = if (body.isEmpty()) emptyList() else body.split('\n')
    val detail = if (lines.size == 1 && body.length <= 120) body else ""
    val long = body.isNotEmpty() && detail.isEmpty()
    val name = if (isRunCode(item)) "Run Code" else item.toolName ?: "工具"
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(6.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("${status.icon} ${status.label}", style = MaterialTheme.typography.labelSmall, color = status.color)
            Text(
                "  $name",
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.padding(start = 6.dp),
                maxLines = 1,
            )
            if (detail.isNotEmpty()) Text(
                "  $detail",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            ) else androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            if (long) TextButton(onClick = { open = !open }, modifier = Modifier.heightIn(min = 28.dp)) {
                Text(
                    if (open) "收起输出" else if (isRunCode(item)) "展开 Run Code" else "展开输出",
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        if (long && open) {
            SelectionContainer {
                androidx.compose.foundation.layout.Box(
                    Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                ) {
                    MarkdownBody(item.text, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl)
                }
            }
        }
    }
}

@Composable
internal fun NativeMessageCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onFork: ((String) -> Unit)? = null,
    enabled: Boolean = true,
) {
    var expanded by remember(item.id) { mutableStateOf(false) }
    var showThinking by remember(item.id) { mutableStateOf(false) }
    val lines = item.text.split('\n')
    val long = lines.size > PREVIEW_LINES || item.text.length > PREVIEW_CHARS
    val visible = if (long && !expanded) lines.take(PREVIEW_LINES).joinToString("\n").take(PREVIEW_CHARS) else item.text
    val background = when {
        item.isError -> MaterialTheme.colorScheme.errorContainer
        item.role == "user" -> MaterialTheme.colorScheme.primaryContainer
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Column(
        Modifier.fillMaxWidth().background(background, MaterialTheme.shapes.medium).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(
                when (item.role) {
                    "user" -> "你"
                    "assistant" -> "Pi"
                    else -> item.role
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (item.isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (item.status == "running") Text("  进行中", style = MaterialTheme.typography.labelSmall)
            androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            if (!item.thinking.isNullOrBlank()) TextButton(onClick = { showThinking = !showThinking }) {
                Text(if (showThinking) "收起思考" else "查看思考", style = MaterialTheme.typography.labelSmall)
            }
        }
        if (showThinking) item.thinking?.let {
            Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
        }
        item.images.forEachIndexed { index, image ->
            val bitmap = remember(image.data) {
                runCatching {
                    val bytes = android.util.Base64.decode(image.data, android.util.Base64.DEFAULT)
                    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                }.getOrNull()
            }
            if (bitmap != null) Image(bitmap, "附件 ${index + 1}", Modifier.size(120.dp), contentScale = ContentScale.Fit)
        }
        if (item.text.isNotBlank()) MarkdownBody(visible, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl)
        if (long) TextButton(onClick = { expanded = !expanded }) {
            Text(
                if (expanded) "收起正文" else "展开全部正文（${lines.size} 行）",
                style = MaterialTheme.typography.labelSmall,
            )
        }
        if (item.role == "user" && item.forkable && !item.entryId.isNullOrBlank() && onFork != null) {
            TextButton(enabled = enabled, onClick = { onFork(item.entryId) }) {
                Text("从此消息分叉…", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
internal fun NativeTimelineCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onFork: (String) -> Unit,
    enabled: Boolean,
) {
    if (isToolItem(item)) NativeStepCard(item, onOpenPath, onOpenUrl)
    else NativeMessageCard(item, onOpenPath, onOpenUrl, onFork, enabled)
}