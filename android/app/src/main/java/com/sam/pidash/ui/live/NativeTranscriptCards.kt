package com.sam.pidash.ui.live

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
private fun StatusDot(color: Color, size: Int = 6) {
    Box(Modifier.size(size.dp).background(color, CircleShape))
}

/** A quiet text action: 11 sp, muted, minimal padding — never a Material button. */
@Composable
internal fun MetaAction(text: String, onClick: () -> Unit, enabled: Boolean = true, tint: Color? = null) {
    Text(
        text,
        style = PiType.micro,
        color = tint ?: MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .clip(Radii.chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 3.dp),
    )
}

@Composable
internal fun NativeStepCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    var open by remember(item.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val tint = when {
        item.isError -> scheme.error
        item.status == "running" -> scheme.primary
        else -> scheme.onSurfaceVariant.copy(alpha = 0.65f)
    }
    val name = if (isRunCode(item)) "Run Code" else item.toolName ?: "工具"
    val detail = toolArgumentPreview(item)
    val output = toolOutput(item)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .then(if (output.isNotEmpty()) Modifier.clickable { open = !open } else Modifier)
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(tint)
            Text(
                "  $name",
                style = PiType.monoMicro.copy(fontWeight = FontWeight.SemiBold),
                color = if (item.isError) scheme.error else scheme.onSurface,
                maxLines = 1,
            )
            if (detail.isNotEmpty()) Text(
                "  $detail",
                style = PiType.monoMicro,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            ) else Spacer(Modifier.weight(1f))
            if (output.isNotEmpty()) Text(
                if (open) "⌃" else "⌄",
                style = PiType.micro,
                color = scheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 4.dp, end = 2.dp),
            )
        }
        if (open && output.isNotEmpty()) {
            SelectionContainer {
                Box(
                    Modifier.fillMaxWidth()
                        .padding(start = 2.dp, top = 2.dp, bottom = 6.dp)
                        .border(1.dp, scheme.outline.copy(alpha = 0.6f), Radii.chip)
                        .background(scheme.surfaceVariant.copy(alpha = 0.4f), Radii.chip)
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
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(
                Modifier.widthIn(max = 560.dp)
                    .background(scheme.primary.copy(alpha = 0.12f), Radii.bubble)
                    .padding(horizontal = Spacing.md, vertical = Spacing.sm),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                if (item.text.isNotBlank()) Text(visible, style = PiType.body, color = scheme.onSurface)
                if (long) MetaAction(
                    if (expanded) "收起正文" else "展开全部正文（${lines.size} 行）",
                    { expanded = !expanded },
                    tint = scheme.primary,
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
        return
    }

    Column(
        Modifier.fillMaxWidth()
            .then(
                if (item.isError) Modifier
                    .border(1.dp, scheme.error.copy(alpha = 0.5f), Radii.card)
                    .background(scheme.error.copy(alpha = 0.06f), Radii.card)
                    .padding(Spacing.md)
                else Modifier
            ),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
        if (item.text.isNotBlank()) {
            MarkdownBody(
                visible,
                onOpenPath = onOpenPath,
                onOpenUrl = onOpenUrl,
                style = PiType.body.copy(color = if (item.isError) scheme.error else scheme.onSurface),
            )
            if (long) MetaAction(
                if (expanded) "收起正文" else "展开全部正文（${lines.size} 行）",
                { expanded = !expanded },
                tint = scheme.primary,
            )
        }
        val hasMeta = !item.thinking.isNullOrBlank() || item.text.isNotBlank()
        if (hasMeta) Row(
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
            Box(
                Modifier.fillMaxWidth()
                    .border(1.dp, scheme.outline.copy(alpha = 0.6f), Radii.chip)
                    .background(scheme.surfaceVariant.copy(alpha = 0.35f), Radii.chip)
                    .padding(Spacing.sm),
            ) {
                SelectionContainer {
                    Text(it, style = PiType.monoMicro, color = scheme.onSurfaceVariant)
                }
            }
        }
        if (item.isError && item.text.isBlank()) {
            Text("出错了", style = PiType.meta, color = scheme.error)
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
    val (tint, state) = when {
        group.failed -> scheme.error to "含失败"
        group.running -> scheme.primary to "进行中"
        else -> scheme.onSurfaceVariant.copy(alpha = 0.65f) to "已完成"
    }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(tint)
            Text(
                "  ${group.items.size} 个步骤",
                style = PiType.strong,
                color = if (group.failed) scheme.error else scheme.onSurface,
            )
            Text(
                "  $state",
                style = PiType.micro,
                color = tint,
            )
            Text(
                "  ${group.names.joinToString(" · ")}",
                style = PiType.monoMicro,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                if (open) "⌃" else "⌄",
                style = PiType.micro,
                color = scheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Spacing.xs, end = 2.dp),
            )
        }
        if (open) Row(Modifier.fillMaxWidth()) {
            Box(
                Modifier.padding(start = 2.dp, top = 2.dp, bottom = 2.dp).widthIn(min = 1.dp)
                    .heightIn(min = 8.dp)
                    .background(scheme.outline.copy(alpha = 0.5f)),
            ) { Spacer(Modifier.size(1.dp)) }
            Column(
                Modifier.weight(1f).padding(start = Spacing.sm),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                group.items.forEach { item -> NativeStepCard(item, onOpenPath, onOpenUrl) }
            }
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
