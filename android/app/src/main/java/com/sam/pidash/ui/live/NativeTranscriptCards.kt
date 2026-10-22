package com.sam.pidash.ui.live

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.TranscriptRow
import com.sam.pidash.ui.common.MetaAction
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Native transcript cards.
 *
 * Visual rules: the transcript is the product, so it gets the reading type scale and
 * the only accent in the screen; chrome (step rows, metadata actions) stays at 11 sp
 * so a long session never turns into one grey block. Presentation still matches the
 * WebUI — one line per tool call, output collapsed, 12-line reply clipping.
 */

private const val PREVIEW_LINES = 12
private const val PREVIEW_CHARS = 1200
private const val DETAIL_CHARS = 120

private val isToolItem = { item: LiveTimelineItem ->
    item.role == "tool" || item.role == "toolResult" || item.toolCallId != null
}

/** `cd /repo && npm test` — one readable line instead of raw JSON. */
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
    val name = if (isRunCode(item)) "Run Code" else item.toolName ?: "工具"
    val detail = toolArgumentPreview(item)
    val output = toolOutput(item)
    val active = item.isError || item.status == "running"
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .then(if (output.isNotEmpty()) Modifier.clickable { open = !open } else Modifier)
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (active) {
                StatusDot(if (item.isError) scheme.error else scheme.primary)
                Spacer(Modifier.size(6.dp))
            }
            Text(
                name,
                style = PiType.monoMicro,
                color = if (item.isError) scheme.error else scheme.onSurface.copy(alpha = 0.9f),
                maxLines = 1,
            )
            if (detail.isNotEmpty()) {
                Spacer(Modifier.size(Spacing.sm))
                Text(
                    detail,
                    style = PiType.monoMicro,
                    color = scheme.onSurfaceVariant.copy(alpha = 0.8f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            } else Spacer(Modifier.weight(1f))
            if (output.isNotEmpty()) Text(
                if (open) "⌃" else "⌄",
                style = PiType.action,
                color = scheme.onSurfaceVariant.copy(alpha = 0.7f),
                modifier = Modifier.padding(start = Spacing.xs),
            )
        }
        if (open && output.isNotEmpty()) {
            SelectionContainer {
                Box(
                    Modifier.fillMaxWidth()
                        .padding(top = Spacing.xs, bottom = Spacing.sm)
                        .background(scheme.surfaceVariant.copy(alpha = 0.5f), Radii.chip)
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(Spacing.sm),
                ) {
                    MarkdownBody(output, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl, style = PiType.mono)
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
    onQuote: ((LiveTimelineItem) -> Unit)? = null,
    onAnnotate: ((LiveTimelineItem) -> Unit)? = null,
) {
    var expanded by remember(item.id) { mutableStateOf(false) }
    var showThinking by remember(item.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val lines = item.text.split('\n')
    val long = lines.size > PREVIEW_LINES || item.text.length > PREVIEW_CHARS
    val visible = if (long && !expanded) lines.take(PREVIEW_LINES).joinToString("\n").take(PREVIEW_CHARS) else item.text
    val user = item.role == "user"

    if (user) {
        // No bubble: the reader's own text is right-aligned and marked by a hairline.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Row(Modifier.widthIn(max = 560.dp)) {
                Box(
                    Modifier.padding(top = 3.dp, bottom = 3.dp).widthIn(min = 2.dp)
                        .height(IntrinsicSize.Min)
                        .background(scheme.outline, Radii.chip),
                ) { Spacer(Modifier.size(2.dp)) }
                Column(
                    Modifier.padding(start = Spacing.sm),
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                    if (item.text.isNotBlank()) Text(visible, style = PiType.body, color = scheme.onSurface)
                    if (long) MetaAction(
                        if (expanded) "收起" else "展开全部（${lines.size} 行）",
                        { expanded = !expanded },
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        if (onQuote != null && item.text.isNotBlank()) MetaAction("引用", { onQuote(item) }, enabled)
                        if (onAnnotate != null && item.text.isNotBlank()) MetaAction("批注", { onAnnotate(item) }, enabled)
                        if (item.forkable && !item.entryId.isNullOrBlank() && onFork != null) {
                            MetaAction("分叉", { onFork(item.entryId) }, enabled)
                        }
                    }
                }
            }
        }
        return
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
        if (item.text.isNotBlank()) {
            MarkdownBody(
                visible,
                onOpenPath = onOpenPath,
                onOpenUrl = onOpenUrl,
                style = PiType.body.copy(color = if (item.isError) scheme.error else scheme.onSurface),
            )
            if (long) MetaAction(if (expanded) "收起" else "展开全部（${lines.size} 行）", { expanded = !expanded })
        }
        if (item.isError && item.text.isBlank()) Text("出错了", style = PiType.meta, color = scheme.error)
        Row(
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!item.thinking.isNullOrBlank()) {
                MetaAction(if (showThinking) "收起思考" else "思考", { showThinking = !showThinking })
            }
            if (item.text.isNotBlank()) {
                if (onQuote != null) MetaAction("引用", { onQuote(item) }, enabled)
                if (onAnnotate != null) MetaAction("批注", { onAnnotate(item) }, enabled)
            }
        }
        if (showThinking) item.thinking?.let {
            SelectionContainer {
                Text(
                    it,
                    style = PiType.monoMicro,
                    color = scheme.onSurfaceVariant.copy(alpha = 0.9f),
                    modifier = Modifier.padding(start = Spacing.sm),
                )
            }
        }
    }
}

@Composable
private fun AttachmentImage(data: String, index: Int) {
    val bitmap = remember(data) {
        runCatching {
            val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
    if (bitmap != null) Image(
        bitmap,
        "附件 ${index + 1}",
        Modifier.size(160.dp).clip(RoundedCornerShape(10.dp)),
        contentScale = ContentScale.Crop,
    )
}

/**
 * A run of consecutive tool calls folded into one row: a status dot, the step count,
 * the tool names, and a chevron. Expanded steps hang off a hairline rule so the group
 * still reads as one block.
 */
@Composable
internal fun NativeStepGroup(
    group: TranscriptRow.Steps,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    var open by remember(group.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val state = when {
        group.failed -> "失败" to scheme.error
        group.running -> "进行中" to scheme.primary
        else -> "已完成" to scheme.onSurfaceVariant
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (open) "⌃" else "⌄", style = PiType.action, color = scheme.onSurfaceVariant)
            Spacer(Modifier.size(Spacing.xs))
            Text(
                "${group.items.size} 个步骤",
                style = PiType.strong,
                color = scheme.onSurface.copy(alpha = 0.9f),
            )
            Spacer(Modifier.size(Spacing.sm))
            Text(state.first, style = PiType.micro, color = state.second)
            if (group.names.isNotEmpty()) {
                Spacer(Modifier.size(Spacing.sm))
                Text(
                    group.names.joinToString(" · "),
                    style = PiType.monoMicro,
                    color = scheme.onSurfaceVariant.copy(alpha = 0.8f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (open) Column(
            Modifier.fillMaxWidth().padding(start = Spacing.md),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            group.items.forEach { item -> NativeStepCard(item, onOpenPath, onOpenUrl) }
        }
    }
}

/** A faint rule between logical blocks keeps long transcripts scannable. */
@Composable
internal fun TranscriptSeparator() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
}

@Composable
internal fun NativeTimelineRow(
    row: TranscriptRow,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onFork: (String) -> Unit,
    enabled: Boolean,
    onQuote: (LiveTimelineItem) -> Unit,
    onAnnotate: (LiveTimelineItem) -> Unit,
) {
    when (row) {
        is TranscriptRow.Single -> {
            val item = row.item
            if (isToolItem(item)) NativeStepCard(item, onOpenPath, onOpenUrl)
            else NativeMessageCard(item, onOpenPath, onOpenUrl, onFork, enabled, onQuote, onAnnotate)
        }
        is TranscriptRow.Steps -> NativeStepGroup(row, onOpenPath, onOpenUrl)
    }
}
