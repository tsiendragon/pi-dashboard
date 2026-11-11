package com.sam.pidash.ui.live

import androidx.compose.foundation.Image
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.sam.pidash.domain.model.wholeMessageText
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.TranscriptRow
import com.sam.pidash.ui.common.CopyTextAction
import com.sam.pidash.ui.common.rememberCopyText
import com.sam.pidash.ui.common.InsetSeparator
import com.sam.pidash.ui.common.rememberAttachmentBitmap
import com.sam.pidash.ui.common.ImageViewerDialog
import com.sam.pidash.ui.common.Collapsible
import com.sam.pidash.ui.common.ExpandHint
import com.sam.pidash.ui.common.MetaAction
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.common.PulsingDot
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.codeTextStyle
import com.sam.pidash.ui.theme.Tints
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NativeStepCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    showArguments: Boolean = false,
    precedingThinking: List<LiveTimelineItem> = emptyList(),
) {
    var open by remember(item.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val name = if (isRunCode(item)) "Run Code" else item.toolName ?: "工具"
    val detail = toolArgumentPreview(item)
    val output = toolOutput(item)
    val arguments = item.toolArgs?.takeIf { showArguments && it.isNotBlank() }?.let {
        if (it.length > 65_536) it.take(65_536) + "\n（展示已截断；可复制原文，或在 WebUI 查看）" else it
    }
    val toolThinking = item.thinking?.takeIf { showArguments && it.isNotBlank() }
    val thinkingText = (precedingThinking.mapNotNull { it.thinking } + listOfNotNull(toolThinking)).joinToString("\n\n")
    val thinkingCount = precedingThinking.size + if (toolThinking != null) 1 else 0
    val hasCopyableArgs = !item.toolArgs.isNullOrBlank()
    val expandable = output.isNotEmpty() || hasCopyableArgs || thinkingCount > 0 || (showArguments && item.images.isNotEmpty())
    val active = item.isError || item.status == "error" || item.status == "running"
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        Row(
            Modifier.fillMaxWidth()
                .then(if (expandable) Modifier.clickable { open = !open } else Modifier)
                .then(if (showArguments && expandable) Modifier.heightIn(min = 48.dp) else Modifier)
                .padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (active) {
                if (item.isError || item.status == "error") StatusDot(scheme.error)
                else PulsingDot(scheme.primary, size = 5.dp)
                Spacer(Modifier.size(6.dp))
            }
            Text(
                name,
                style = PiType.monoMicro,
                color = if (item.isError || item.status == "error") scheme.error else scheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = if (showArguments) Modifier.widthIn(max = 96.dp) else Modifier,
            )
            if (detail.isNotEmpty()) {
                Spacer(Modifier.size(Spacing.sm))
                Text(
                    detail,
                    style = PiType.monoMicro,
                    color = scheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            } else Spacer(Modifier.weight(1f))
            val statusLabel = when {
                item.isError || item.status == "error" -> "失败"
                item.status == "running" -> "进行中"
                item.status != "done" -> "未确认"
                else -> null
            }
            if (showArguments && statusLabel != null) {
                Text(
                    statusLabel,
                    style = PiType.caption,
                    color = if (item.isError || item.status == "error") scheme.error else scheme.onSurfaceVariant,
                    maxLines = 1,
                    modifier = Modifier.padding(start = Spacing.xs),
                )
            }
            if (thinkingCount > 0) Text(
                if (thinkingCount == 1) "思考" else "$thinkingCount 段思考",
                style = PiType.caption, color = scheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Spacing.sm),
            )
            if (expandable) Icon(
                imageVector = if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = if (showArguments || hasCopyableArgs) { if (open) "收起记录" else "展开记录" }
                    else { if (open) "收起输出" else "展开输出" },
                tint = scheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Spacing.xs).size(16.dp),
            )
        }
        Collapsible(visible = open && expandable) {
            SelectionContainer {
                Column(
                    Modifier.fillMaxWidth()
                        .padding(top = Spacing.xs, bottom = Spacing.sm)
                        .background(scheme.surfaceVariant.copy(alpha = Tints.Block), Radii.chip)
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(Spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        CopyTextAction(wholeMessageText(item.copy(thinking =
                            (precedingThinking.mapNotNull { it.thinking } + listOfNotNull(item.thinking))
                                .filter { it.isNotEmpty() }.joinToString("\n\n").ifEmpty { null })), "复制整条")
                        if (thinkingText.isNotEmpty()) CopyTextAction(thinkingText, "复制思考")
                        if (hasCopyableArgs) CopyTextAction(item.toolArgs.orEmpty(), "复制参数")
                        if (output.isNotEmpty()) CopyTextAction(item.text, "复制输出")
                    }
                    precedingThinking.forEachIndexed { index, thought ->
                        Text(if (precedingThinking.size == 1) "执行前思考" else "执行前思考 ${index + 1}",
                            style = PiType.caption, color = scheme.onSurfaceVariant)
                        Text(thought.thinking.orEmpty(), style = codeTextStyle(PiType.mono), color = scheme.onSurfaceVariant)
                    }
                    if (toolThinking != null) {
                        Text("思考", style = PiType.caption, color = scheme.onSurfaceVariant)
                        Text(toolThinking, style = codeTextStyle(PiType.mono), color = scheme.onSurface)
                    }
                    if (arguments != null) {
                        Text("参数", style = PiType.caption, color = scheme.onSurfaceVariant)
                        Text(arguments, style = codeTextStyle(PiType.mono), color = scheme.onSurface)
                    }
                    if (output.isNotEmpty()) {
                        if (arguments != null || thinkingCount > 0) Text("输出", style = PiType.caption, color = scheme.onSurfaceVariant)
                        MarkdownBody(output, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl, style = codeTextStyle(PiType.mono))
                    }
                    if (showArguments) item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NativeMessageCard(
    item: LiveTimelineItem,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onFork: ((String) -> Unit)? = null,
    enabled: Boolean = true,
    onQuote: ((LiveTimelineItem) -> Unit)? = null,
    onAnnotate: ((LiveTimelineItem) -> Unit)? = null,
    compactUser: Boolean = false,
    compactAssistant: Boolean = false,
    expandedByDefault: Boolean = false,
) {
    val copy = rememberCopyText()
    val whole = remember(item) { wholeMessageText(item) }
    var expanded by remember(item.id) { mutableStateOf(expandedByDefault) }
    var showThinking by remember(item.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val preview = remember(item.text, expanded) { transcriptPreview(item.text, expanded) }
    val long = preview.long
    val visible = preview.visible
    val user = item.role == "user"

    if (user && compactUser) {
        val canFork = item.forkable && !item.entryId.isNullOrBlank() && onFork != null
        val hasActions = whole.isNotEmpty() || long || canFork
        var menuOpen by remember(item.id) { mutableStateOf(false) }
        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Row(
                Modifier.widthIn(max = minOf(560.dp, maxWidth * 0.9f))
                    .background(scheme.primaryContainer, RoundedCornerShape(16.dp))
                    .padding(start = Spacing.md, end = if (hasActions) 0.dp else Spacing.md, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Column(
                    Modifier.weight(1f, fill = false).padding(vertical = 7.dp),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                    if (item.text.isNotBlank()) SelectionContainer {
                        Text(visible + if (long && !expanded) "…" else "",
                            style = PiType.userMessage, color = scheme.onPrimaryContainer)
                    }
                }
                if (hasActions) Box {
                    IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Filled.MoreVert, contentDescription = if (long && !expanded) "用户消息操作，可展开全文" else "用户消息操作", tint = scheme.onPrimaryContainer, modifier = Modifier.size(20.dp))
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        if (whole.isNotEmpty()) DropdownMenuItem(text = { Text("复制整条消息") },
                            onClick = { menuOpen = false; copy(whole) })
                        if (item.text.isNotBlank()) DropdownMenuItem(
                            text = { Text("复制文字") },
                            onClick = { menuOpen = false; copy(item.text) },
                        )
                        if (long) DropdownMenuItem(
                            text = { Text(if (expanded) "收起" else "展开全部（${preview.lineCount} 行）") },
                            onClick = { menuOpen = false; expanded = !expanded },
                        )
                        if (onQuote != null && item.text.isNotBlank()) DropdownMenuItem(
                            text = { Text("引用") }, enabled = enabled,
                            onClick = { menuOpen = false; onQuote(item) },
                        )
                        if (onAnnotate != null && item.text.isNotBlank()) DropdownMenuItem(
                            text = { Text("批注") }, enabled = enabled,
                            onClick = { menuOpen = false; onAnnotate(item) },
                        )
                        if (canFork) DropdownMenuItem(
                            text = { Text("分叉") }, enabled = enabled,
                            onClick = { menuOpen = false; onFork?.invoke(item.entryId.orEmpty()) },
                        )
                    }
                }
            }
        }
        return
    }
    if (user) {
        // iOS Messages shape: your own words are the only filled surface in the screen.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(
                Modifier.widthIn(max = 560.dp)
                    .background(
                        scheme.primary,
                        RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 18.dp),
                    )
                    .padding(horizontal = Spacing.md, vertical = 9.dp),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                if (item.text.isNotBlank()) SelectionContainer {
                    Text(visible, style = PiType.userMessage, color = scheme.onPrimary)
                }
                if (long) MetaAction(
                    if (expanded) "收起" else "展开全部（${preview.lineCount} 行）",
                    { expanded = !expanded },
                    tint = scheme.onPrimary,
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    val tint = scheme.onPrimary
                    if (whole.isNotEmpty()) CopyTextAction(whole, "复制整条消息", tint)
                    if (item.text.isNotBlank()) CopyTextAction(item.text, "复制文字", tint)
                    if (onQuote != null && item.text.isNotBlank()) MetaAction("引用", { onQuote(item) }, enabled, tint)
                    if (onAnnotate != null && item.text.isNotBlank()) MetaAction("批注", { onAnnotate(item) }, enabled, tint)
                    if (item.forkable && !item.entryId.isNullOrBlank() && onFork != null) {
                        MetaAction("分叉", { onFork(item.entryId) }, enabled, tint)
                    }
                }
            }
        }
        return
    }

    if (compactAssistant) {
        val hasThinking = !item.thinking.isNullOrBlank()
        val hasContent = item.text.isNotBlank() || item.images.isNotEmpty() || item.isError
        var menuOpen by remember(item.id) { mutableStateOf(false) }
        Column(Modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            if (hasContent) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
                        if (item.text.isNotBlank()) MarkdownBody(
                            visible + if (long && !expanded) "…" else "",
                            onOpenPath = onOpenPath,
                            onOpenUrl = onOpenUrl,
                            style = PiType.body.copy(color = if (item.isError) scheme.error else scheme.onSurface),
                        )
                        if (item.isError && item.text.isBlank()) Text("出错了", style = PiType.meta, color = scheme.error)
                    }
                    if (long || hasThinking || whole.isNotEmpty()) Box {
                        IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(48.dp)) {
                            Icon(Icons.Filled.MoreVert, contentDescription = if (long && !expanded) "回复操作，可展开全文" else "回复操作", tint = scheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            if (whole.isNotEmpty()) DropdownMenuItem(text = { Text("复制整条消息") },
                                onClick = { menuOpen = false; copy(whole) })
                            if (item.text.isNotBlank()) DropdownMenuItem(
                                text = { Text("复制正文") }, onClick = { menuOpen = false; copy(item.text) },
                            )
                            if (hasThinking) DropdownMenuItem(
                                text = { Text("复制思考") }, onClick = { menuOpen = false; copy(item.thinking.orEmpty()) },
                            )
                            if (long) DropdownMenuItem(
                                text = { Text(if (expanded) "收起" else "展开全部（${preview.lineCount} 行）") },
                                onClick = { menuOpen = false; expanded = !expanded },
                            )
                            if (hasThinking) DropdownMenuItem(
                                text = { Text(if (showThinking) "收起思考" else "查看思考") },
                                onClick = { menuOpen = false; showThinking = !showThinking },
                            )
                            if (onQuote != null && item.text.isNotBlank()) DropdownMenuItem(
                                text = { Text("引用") }, enabled = enabled,
                                onClick = { menuOpen = false; onQuote(item) },
                            )
                            if (onAnnotate != null && item.text.isNotBlank()) DropdownMenuItem(
                                text = { Text("批注") }, enabled = enabled,
                                onClick = { menuOpen = false; onAnnotate(item) },
                            )
                        }
                    }
                }
            } else if (hasThinking) {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(Radii.chip)
                        .clickable { showThinking = !showThinking }.padding(horizontal = Spacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(if (showThinking) "收起思考" else "思考", style = PiType.caption, color = scheme.onSurfaceVariant)
                    Text(item.thinking.orEmpty().lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(160).orEmpty(),
                        modifier = Modifier.weight(1f).padding(horizontal = Spacing.sm), style = PiType.footnote,
                        color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(if (showThinking) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = null, modifier = Modifier.size(16.dp), tint = scheme.onSurfaceVariant)
                }
            }
            Collapsible(visible = showThinking && item.thinking != null) { item.thinking?.let {
                SelectionContainer {
                    Column {
                        Text(it, style = PiType.monoMicro, color = scheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = Spacing.sm))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            if (!hasContent) CopyTextAction(whole, "复制整条消息")
                            CopyTextAction(it, "复制思考")
                        }
                    }
                }
            } }
        }
        return
    }

    Column(Modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        item.images.forEachIndexed { index, image -> AttachmentImage(image.data, index) }
        if (item.text.isNotBlank()) {
            MarkdownBody(
                visible,
                onOpenPath = onOpenPath,
                onOpenUrl = onOpenUrl,
                style = PiType.body.copy(color = if (item.isError) scheme.error else scheme.onSurface),
            )
            if (long) MetaAction(if (expanded) "收起" else "展开全部（${preview.lineCount} 行）", { expanded = !expanded })
        }
        if (item.isError && item.text.isBlank()) Text("出错了", style = PiType.meta, color = scheme.error)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            if (whole.isNotEmpty()) CopyTextAction(whole, "复制整条消息")
            if (!item.thinking.isNullOrBlank()) {
                MetaAction(if (showThinking) "收起思考" else "思考", { showThinking = !showThinking })
            }
            if (item.text.isNotBlank()) {
                CopyTextAction(item.text, "复制正文")
                if (onQuote != null) MetaAction("引用", { onQuote(item) }, enabled)
                if (onAnnotate != null) MetaAction("批注", { onAnnotate(item) }, enabled)
            }
        }
        Collapsible(visible = showThinking && item.thinking != null) { item.thinking?.let {
            SelectionContainer {
                Column {
                    Text(it, style = PiType.monoMicro, color = scheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Spacing.sm))
                    CopyTextAction(it, "复制思考")
                }
            }
        } }
    }
}

@Composable
private fun AttachmentImage(data: String, index: Int) {
    val bitmap = rememberAttachmentBitmap(data)
    var open by remember(data) { mutableStateOf(false) }
    Box(
        Modifier.size(160.dp).clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = Tints.Block))
            .clickable(enabled = bitmap != null) { open = true },
    ) {
        if (bitmap != null) Image(
            bitmap,
            "附件 ${index + 1}，点按查看大图",
            Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop,
        )
    }
    if (open && bitmap != null) ImageViewerDialog(bitmap) { open = false }
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
            Modifier.fillMaxWidth().clip(Radii.chip)
                .background(scheme.surfaceVariant.copy(alpha = Tints.Block))
                .clickable { open = !open }.heightIn(min = 48.dp)
                .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = if (open) "收起" else "展开",
                tint = scheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.size(Spacing.xs))
            Text(
                "${group.items.size} 个步骤",
                style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                color = scheme.onSurface,
            )
            Spacer(Modifier.size(Spacing.sm))
            Text(state.first, style = PiType.micro, color = state.second)
            if (group.names.isNotEmpty()) {
                Spacer(Modifier.size(Spacing.sm))
                Text(
                    group.names.joinToString(" · "),
                    style = PiType.monoMicro,
                    color = scheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (open) Column(Modifier.fillMaxWidth().padding(start = Spacing.md)) {
            group.items.forEachIndexed { index, item ->
                if (index > 0) InsetSeparator(inset = 0.dp)
                NativeStepCard(item, onOpenPath, onOpenUrl)
            }
        }
    }
}

/** A faint rule between logical blocks keeps long transcripts scannable. */
@Composable
internal fun TranscriptSeparator() {
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
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
    compactUser: Boolean = false,
    compactAssistant: Boolean = false,
    expandedByDefault: Boolean = false,
) {
    when (row) {
        is TranscriptRow.Single -> {
            val item = row.item
            if (isToolItem(item)) NativeStepCard(item, onOpenPath, onOpenUrl)
            else NativeMessageCard(item, onOpenPath, onOpenUrl, onFork, enabled, onQuote, onAnnotate, compactUser, compactAssistant, expandedByDefault)
        }
        is TranscriptRow.Steps -> NativeStepGroup(row, onOpenPath, onOpenUrl)
    }
}
