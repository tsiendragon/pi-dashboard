package com.sam.pidash.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp

/**
 * Native Markdown rendering for the transcript.
 *
 * Layout rules follow the WebUI rather than inventing new ones: fenced code keeps
 * its own horizontal scroll instead of wrapping, tables scroll inside their own
 * box, long paragraphs simply flow. Links and local paths stay tappable through
 * the same callbacks the WebView renderer used.
 */
@Composable
fun MarkdownBody(
    markdown: String,
    modifier: Modifier = Modifier,
    onOpenPath: (String) -> Unit = {},
    onOpenUrl: (String) -> Unit = {},
    style: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    val blocks = remember(markdown) { MarkdownParser.parse(markdown) }
    Column(modifier, verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block -> Block(block, style, onOpenPath, onOpenUrl) }
    }
}

@Composable
private fun Block(block: MdBlock, style: TextStyle, onOpenPath: (String) -> Unit, onOpenUrl: (String) -> Unit) {
    when (block) {
        is MdBlock.Heading -> {
            val scale = when (block.level) { 1 -> 1.35f; 2 -> 1.2f; 3 -> 1.08f; else -> 1f }
            InlineText(
                MarkdownParser.inline(block.text),
                style.copy(fontSize = style.fontSize * scale, fontWeight = FontWeight.SemiBold),
                onOpenPath, onOpenUrl,
            )
        }
        is MdBlock.Paragraph -> InlineText(MarkdownParser.inline(block.text), style, onOpenPath, onOpenUrl)
        is MdBlock.Code -> CodeBlock(block)
        is MdBlock.Bullets -> Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(2.dp)) {
            block.items.forEachIndexed { index, item ->
                Row(Modifier.padding(start = (item.depth * 12).dp)) {
                    Text(
                        text = if (block.ordered) "${block.start + index}." else "•",
                        style = style, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.widthIn(min = 18.dp),
                    )
                    InlineText(MarkdownParser.inline(item.text), style, onOpenPath, onOpenUrl)
                }
            }
        }
        is MdBlock.Quote -> Row(Modifier.fillMaxWidth()) {
            Box(Modifier.widthIn(min = 3.dp).background(MaterialTheme.colorScheme.outlineVariant))
            Column(
                Modifier.padding(start = 8.dp),
                verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp),
            ) {
                block.blocks.forEach { child -> Block(child, style.copy(color = MaterialTheme.colorScheme.onSurfaceVariant), onOpenPath, onOpenUrl) }
            }
        }
        is MdBlock.Table -> TableBlock(block, style, onOpenPath, onOpenUrl)
        MdBlock.Rule -> HorizontalDivider()
    }
}

@Composable
private fun CodeBlock(block: MdBlock.Code) {
    val clipboard = LocalClipboardManager.current
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val highlighted = remember(block.code, block.language, dark) {
        val tokens = SyntaxHighlighter.highlight(block.code, block.language)
        if (tokens.isEmpty()) AnnotatedString(block.code) else buildAnnotatedString {
            var cursor = 0
            tokens.forEach { token ->
                if (token.start > cursor) append(block.code.substring(cursor, token.start))
                pushStyle(SpanStyle(color = codeColor(token.kind, dark)))
                append(block.code.substring(token.start, token.end))
                pop()
                cursor = token.end
            }
            if (cursor < block.code.length) append(block.code.substring(cursor))
        }
    }
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
            .padding(vertical = 4.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp)) {
            Text(
                block.language ?: "code",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { clipboard.setText(AnnotatedString(block.code)) }) {
                Text("复制", style = MaterialTheme.typography.labelSmall)
            }
        }
        // Same rule as the WebUI: code keeps its own horizontal scroll, no wrapping.
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp)) {
            Text(highlighted, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
        }
    }
}

@Composable
private fun TableBlock(block: MdBlock.Table, style: TextStyle, onOpenPath: (String) -> Unit, onOpenUrl: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Row {
            block.header.forEach { cell ->
                Box(Modifier.widthIn(min = 110.dp, max = 240.dp).padding(4.dp)) {
                    InlineText(MarkdownParser.inline(cell), style.copy(fontWeight = FontWeight.SemiBold), onOpenPath, onOpenUrl)
                }
            }
        }
        HorizontalDivider()
        block.rows.forEach { row ->
            Row {
                row.forEach { cell ->
                    Box(Modifier.widthIn(min = 110.dp, max = 240.dp).padding(4.dp)) {
                        InlineText(MarkdownParser.inline(cell), style, onOpenPath, onOpenUrl)
                    }
                }
            }
        }
    }
}

/** Palette is fixed per theme: readable on both surfaces and independent of the dashboard theme. */
private fun codeColor(kind: CodeTokenKind, dark: Boolean): Color = when (kind) {
    CodeTokenKind.Keyword -> if (dark) Color(0xFFC792EA) else Color(0xFF7C3AED)
    CodeTokenKind.String -> if (dark) Color(0xFFC3E88D) else Color(0xFF047857)
    CodeTokenKind.Comment -> if (dark) Color(0xFF7F8C98) else Color(0xFF6B7280)
    CodeTokenKind.Number -> if (dark) Color(0xFFF78C6C) else Color(0xFFB45309)
    CodeTokenKind.Type -> if (dark) Color(0xFF82AAFF) else Color(0xFF1D4ED8)
    CodeTokenKind.Function -> if (dark) Color(0xFF89DDFF) else Color(0xFF0E7490)
    CodeTokenKind.Plain -> Color.Unspecified
}

private class TapSpan(val start: Int, val end: Int, val url: String?, val path: String?)

private val PATH_TOKEN = Regex("(?:~|\\.{0,2})?/[\\w.@~+-]+(?:/[\\w.@~+-]+)*\\.[A-Za-z0-9]{1,8}")
private val URL_TOKEN = Regex("https?://[^\\s<>()\\[\\]]+")

@Composable
private fun InlineText(
    inlines: List<MdInline>,
    style: TextStyle,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val linkColor = MaterialTheme.colorScheme.primary
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant
    val pathColor = MaterialTheme.colorScheme.tertiary
    val taps = remember(inlines) { mutableListOf<TapSpan>() }
    val annotated = remember(inlines, linkColor, pathColor, codeBackground) {
        taps.clear()
        buildInline(inlines, taps, linkColor, pathColor, codeBackground)
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    Text(
        text = annotated,
        style = style,
        onTextLayout = { layout = it },
        modifier = Modifier.pointerInput(annotated) {
            detectTapGestures { offset ->
                val result = layout ?: return@detectTapGestures
                val index = result.getOffsetForPosition(offset)
                val span = taps.firstOrNull { index in it.start until it.end } ?: return@detectTapGestures
                span.url?.let(onOpenUrl) ?: span.path?.let(onOpenPath)
            }
        },
    )
}

private fun buildInline(
    inlines: List<MdInline>,
    taps: MutableList<TapSpan>,
    linkColor: Color,
    pathColor: Color,
    codeBackground: Color,
): AnnotatedString = buildAnnotatedString {
    fun emit(list: List<MdInline>, style: SpanStyle?) {
        list.forEach { node ->
            when (node) {
                is MdInline.Text -> if (style != null) {
                    pushStyle(style); append(node.value); pop()
                } else {
                    appendTappable(node.value, taps, linkColor, pathColor)
                }
                is MdInline.Code -> {
                    pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground))
                    append(" "); append(node.value); append(" ")
                    pop()
                }
                is MdInline.Strong -> emit(node.children, (style ?: SpanStyle()).copy(fontWeight = FontWeight.Bold))
                is MdInline.Em -> emit(node.children, (style ?: SpanStyle()).copy(fontStyle = FontStyle.Italic))
                is MdInline.Strike -> emit(node.children, (style ?: SpanStyle()).copy(textDecoration = TextDecoration.LineThrough))
                is MdInline.Link -> {
                    val start = length
                    emit(node.children, style)
                    val external = node.href.startsWith("http")
                    addStyle(SpanStyle(color = if (external) linkColor else pathColor, textDecoration = TextDecoration.Underline), start, length)
                    taps += if (external) TapSpan(start, length, node.href, null) else TapSpan(start, length, null, node.href)
                }
            }
        }
    }
    emit(inlines, null)
}

/** Bare URLs and file paths stay tappable without changing the visible text. */
private fun AnnotatedString.Builder.appendTappable(
    text: String,
    taps: MutableList<TapSpan>,
    linkColor: Color,
    pathColor: Color,
) {
    val matches = mutableListOf<Triple<Int, Int, Pair<String, Boolean>>>()
    URL_TOKEN.findAll(text).forEach { matches += Triple(it.range.first, it.range.last + 1, it.value to true) }
    PATH_TOKEN.findAll(text).forEach { match ->
        if (URL_TOKEN.find(match.value) == null) matches += Triple(match.range.first, match.range.last + 1, match.value to false)
    }
    var cursor = 0
    matches.sortedBy { it.first }.forEach { (start, end, value) ->
        if (start < cursor) return@forEach
        append(text.substring(cursor, start))
        val base = length
        pushStyle(SpanStyle(color = if (value.second) linkColor else pathColor, textDecoration = TextDecoration.Underline))
        append(text.substring(start, end))
        pop()
        taps += if (value.second) TapSpan(base, length, value.first, null) else TapSpan(base, length, null, value.first)
        cursor = end
    }
    append(text.substring(cursor))
}
