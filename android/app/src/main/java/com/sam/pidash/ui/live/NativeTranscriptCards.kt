package com.sam.pidash.ui.live

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.markdown.MarkdownBody
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Native transcript cards. Presentation follows the WebUI:
 *
 * - every tool call is ONE line (status · name · argument preview) and its output
 *   stays collapsed until tapped;
 * - a reply longer than 12 lines or 1200 characters is clipped with the same
 *   "展开全部正文（N 行）" affordance;
 * - assistant prose has no bubble, the user's own message is tinted, errors are
 *   red. Nothing is rendered as a JSON dump any more.
 */

private const val PREVIEW_LINES = 12
private const val PREVIEW_CHARS = 1200
private const val DETAIL_CHARS = 120

private val isToolItem = { item: LiveTimelineItem ->
    item.role == "tool" || item.role == "toolResult" || item.toolCallId != null
}

/** `bash · cd /repo && npm test` — one readable line instead of raw JSON. */
internal fun toolArgumentPreview(item: LiveTimelineItem): String {
    val raw = item.toolArgs?.trim().orEmpty()
    val parsed = raw.takeIf { it.startsWith("{") }?.let {
        runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull()
    }
    val primary = listOf("command", "path", "file_path", "filePath", "pattern", "url", "prompt", "description")
        .firstNotNullOfOrNull { key -> (parsed?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } }
    val text = primary ?: parsed?.entries?.joinToString(" ") { (key, value) ->
        val shown: String = (value as? JsonPrimitive)?.contentOrNull ?: value.toString()
        "$key=$shown"
    } ?: raw
    return text.replace('\n', ' ').trim().let { if (it.length > DETAIL_CHARS) it.take(DETAIL_CHARS) + "…" else it }
}

private fun toolOutput(item: LiveTimelineItem): String =
    item.text.trim().takeIf { it.isNotEmpty() && it != "已完成" && it != "执行中…" }.orEmpty()

private fun isRunCode(item: LiveTimelineItem) =
    item.toolName?.lowercase()?.let { "run" in it && "code" in it } == true

@Composable
internal fun NativeStepCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    var open by remember(item.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val (icon, tint) = when {
        item.isError -> "!" to scheme.error
        item.status == "running" -> "●" to scheme.primary
        else -> "✓" to scheme.onSurfaceVariant
    }
    val name = if (isRunCode(item)) "Run Code" else item.toolName ?: "工具"
    val detail = toolArgumentPreview(item)
    val output = toolOutput(item)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(icon, color = tint, style = MaterialTheme.typography.labelSmall)
            Text(
                "  $name",
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 1,
            )
            if (detail.isNotEmpty()) Text(
                "  $detail",
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            ) else androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            if (output.isNotEmpty()) TextButton(
                onClick = { open = !open },
                modifier = Modifier.heightIn(min = 26.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 6.dp, vertical = 0.dp),
            ) {
                Text(
                    if (open) "收起" else if (isRunCode(item)) "展开 Run Code" else "展开输出",
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.primary,
                )
            }
        }
        if (open && output.isNotEmpty()) {
            SelectionContainer {
                Column(
                    Modifier.fillMaxWidth().padding(bottom = 4.dp)
                        .background(scheme.surfaceVariant, RoundedCornerShape(6.dp)).padding(8.dp),
                ) {
                    MarkdownBody(output, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl)
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
    val scheme = MaterialTheme.colorScheme
    val lines = item.text.split('\n')
    val long = lines.size > PREVIEW_LINES || item.text.length > PREVIEW_CHARS
    val visible = if (long && !expanded) lines.take(PREVIEW_LINES).joinToString("\n").take(PREVIEW_CHARS) else item.text
    val user = item.role == "user"
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (user) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            Modifier
                .then(if (user) Modifier.widthIn(max = 520.dp) else Modifier.fillMaxWidth())
                .background(
                    when {
                        item.isError -> scheme.errorContainer
                        user -> scheme.primaryContainer
                        else -> androidx.compose.ui.graphics.Color.Transparent
                    },
                    RoundedCornerShape(10.dp),
                )
                .then(if (user || item.isError) Modifier.padding(horizontal = 10.dp, vertical = 8.dp) else Modifier),
            horizontalAlignment = if (user) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (!item.thinking.isNullOrBlank()) TextButton(
                onClick = { showThinking = !showThinking },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                modifier = Modifier.heightIn(min = 24.dp),
            ) {
                Text(
                    if (showThinking) "收起思考" else "查看思考",
                    style = MaterialTheme.typography.labelSmall,
                    color = scheme.onSurfaceVariant,
                )
            }
            if (showThinking) item.thinking?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = scheme.onSurfaceVariant,
                )
            }
            item.images.forEachIndexed { index, image ->
                val bitmap = remember(image.data) {
                    runCatching {
                        val bytes = android.util.Base64.decode(image.data, android.util.Base64.DEFAULT)
                        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                    }.getOrNull()
                }
                if (bitmap != null) Image(bitmap, "附件 ${index + 1}", Modifier.size(140.dp), contentScale = ContentScale.Fit)
            }
            if (item.text.isNotBlank()) {
                if (user) Text(visible, style = MaterialTheme.typography.bodyMedium)
                else MarkdownBody(visible, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl)
                if (long) TextButton(
                    onClick = { expanded = !expanded },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                    modifier = Modifier.heightIn(min = 24.dp),
                ) {
                    Text(
                        if (expanded) "收起正文" else "展开全部正文（${lines.size} 行）",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (user) scheme.onSurfaceVariant else scheme.primary,
                    )
                }
            }
            if (item.isError && item.text.isBlank()) {
                Text("出错了", style = MaterialTheme.typography.bodySmall, color = scheme.error)
            }
            if (item.forkable && !item.entryId.isNullOrBlank() && onFork != null) TextButton(
                enabled = enabled,
                onClick = { onFork(item.entryId) },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                modifier = Modifier.heightIn(min = 24.dp),
            ) {
                Text("从此消息分叉…", style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
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
