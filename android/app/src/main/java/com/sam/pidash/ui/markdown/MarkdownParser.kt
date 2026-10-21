package com.sam.pidash.ui.markdown

/**
 * A deliberately small Markdown parser for the transcript.
 *
 * Scope is what pi actually emits in answers and tool output: headings, fenced
 * code, lists, quotes, tables, rules, and the inline set below. It is pure Kotlin
 * so the block/inline contract can be unit tested without Compose or Android —
 * the renderer only walks the tree.
 */
sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class Code(val language: String?, val code: String) : MdBlock
    data class Bullets(val ordered: Boolean, val start: Int, val items: List<Item>) : MdBlock {
        data class Item(val depth: Int, val text: String)
    }
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class Table(val header: List<String>, val rows: List<List<String>>, val align: List<String>) : MdBlock
    data object Rule : MdBlock
}

sealed interface MdInline {
    data class Text(val value: String) : MdInline
    data class Code(val value: String) : MdInline
    data class Strong(val children: List<MdInline>) : MdInline
    data class Em(val children: List<MdInline>) : MdInline
    data class Strike(val children: List<MdInline>) : MdInline
    data class Link(val children: List<MdInline>, val href: String) : MdInline
}

object MarkdownParser {
    private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
    private val RULE = Regex("^ {0,3}(?:-{3,}|\\*{3,}|_{3,})$")
    private val LIST_ITEM = Regex("^(\\s*)([-*+]|(\\d{1,9})[.)])\\s+(.*)$")
    private val TABLE_DIVIDER = Regex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")

    fun parse(markdown: String): List<MdBlock> {
        val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val out = mutableListOf<MdBlock>()
        var i = 0
        while (i < lines.size) {
            val raw = lines[i]
            val trimmed = raw.trim()
            when {
                trimmed.isEmpty() -> i++
                trimmed.startsWith("```") -> {
                    val language = trimmed.removePrefix("```").trim().takeIf { it.isNotEmpty() }
                    val body = StringBuilder()
                    i++
                    while (i < lines.size && !lines[i].trim().startsWith("```")) {
                        body.append(lines[i]).append('\n')
                        i++
                    }
                    if (i < lines.size) i++ // closing fence
                    out += MdBlock.Code(language, body.toString().trimEnd('\n'))
                }
                HEADING.matches(trimmed) -> {
                    val match = HEADING.matchEntire(trimmed)!!
                    out += MdBlock.Heading(match.groupValues[1].length, match.groupValues[2].trim())
                    i++
                }
                RULE.matches(trimmed) -> { out += MdBlock.Rule; i++ }
                trimmed.startsWith(">") -> {
                    val quoted = mutableListOf<String>()
                    while (i < lines.size && lines[i].trim().startsWith(">")) {
                        quoted += lines[i].trim().removePrefix(">").removePrefix(" ").trimEnd()
                        i++
                    }
                    out += MdBlock.Quote(parse(quoted.joinToString("\n")))
                }
                isTableStart(lines, i) -> {
                    val header = splitRow(lines[i])
                    val align = splitRow(lines[i + 1]).map {
                        when {
                            it.startsWith(":") && it.endsWith(":") -> "center"
                            it.endsWith(":") -> "end"
                            else -> "start"
                        }
                    }
                    i += 2
                    val rows = mutableListOf<List<String>>()
                    while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                        rows += splitRow(lines[i])
                        i++
                    }
                    out += MdBlock.Table(header, rows, align)
                }
                LIST_ITEM.matches(raw) -> {
                    val ordered = LIST_ITEM.matchEntire(raw)!!.groupValues[2].first().isDigit()
                    val start = LIST_ITEM.matchEntire(raw)!!.groupValues[3].toIntOrNull() ?: 1
                    val items = mutableListOf<MdBlock.Bullets.Item>()
                    while (i < lines.size) {
                        val match = LIST_ITEM.matchEntire(lines[i]) ?: break
                        val depth = match.groupValues[1].replace("\t", "  ").length / 2
                        items += MdBlock.Bullets.Item(depth, match.groupValues[4].trim())
                        i++
                        // continuation lines belong to the previous item
                        while (i < lines.size && lines[i].isNotBlank() && !LIST_ITEM.matches(lines[i]) &&
                            !startsOtherBlock(lines, i)) {
                            val last = items.removeAt(items.lastIndex)
                            items += last.copy(text = last.text + " " + lines[i].trim())
                            i++
                        }
                    }
                    out += MdBlock.Bullets(ordered, start, items)
                }
                else -> {
                    val paragraph = mutableListOf<String>()
                    while (i < lines.size && lines[i].isNotBlank() && !startsOtherBlock(lines, i)) {
                        paragraph += lines[i].trim()
                        i++
                    }
                    if (paragraph.isNotEmpty()) out += MdBlock.Paragraph(paragraph.joinToString("\n"))
                }
            }
        }
        return out
    }

    private fun startsOtherBlock(lines: List<String>, index: Int): Boolean {
        val line = lines[index]
        val trimmed = line.trim()
        if (trimmed.startsWith("```") || trimmed.startsWith(">")) return true
        if (HEADING.matches(trimmed) || RULE.matches(trimmed)) return true
        if (LIST_ITEM.matches(line)) return true
        return isTableStart(lines, index)
    }

    private fun isTableStart(lines: List<String>, index: Int): Boolean {
        if (index + 1 >= lines.size) return false
        val head = lines[index]
        val divider = lines[index + 1]
        return head.contains('|') && divider.contains('-') && divider.contains('|') && TABLE_DIVIDER.matches(divider)
    }

    private fun splitRow(line: String): List<String> = line.trim().trim('|').split('|').map { it.trim() }

    /**
     * Inline parsing with the small superset the answers use. Backticks win over
     * everything else so `**not bold**` inside code stays literal.
     */
    fun inline(text: String): List<MdInline> {
        val out = mutableListOf<MdInline>()
        val plain = StringBuilder()
        var i = 0
        fun flush() {
            if (plain.isNotEmpty()) { out += MdInline.Text(plain.toString()); plain.setLength(0) }
        }
        while (i < text.length) {
            val ch = text[i]
            if (ch == '\\' && i + 1 < text.length) { plain.append(text[i + 1]); i += 2; continue }
            if (ch == '`') {
                val close = text.indexOf('`', i + 1)
                if (close > i + 1) { flush(); out += MdInline.Code(text.substring(i + 1, close)); i = close + 1; continue }
            }
            if (text.startsWith("**", i) || text.startsWith("__", i)) {
                val marker = text.substring(i, i + 2)
                val close = text.indexOf(marker, i + 2)
                if (close > i + 2) {
                    flush(); out += MdInline.Strong(inline(text.substring(i + 2, close))); i = close + 2; continue
                }
            }
            if (text.startsWith("~~", i)) {
                val close = text.indexOf("~~", i + 2)
                if (close > i + 2) { flush(); out += MdInline.Strike(inline(text.substring(i + 2, close))); i = close + 2; continue }
            }
            if (ch == '*' || ch == '_') {
                val close = text.indexOf(ch, i + 1)
                if (close > i + 1) { flush(); out += MdInline.Em(inline(text.substring(i + 1, close))); i = close + 1; continue }
            }
            if (ch == '[') {
                val mid = text.indexOf("](", i + 1)
                val end = if (mid > 0) text.indexOf(')', mid + 2) else -1
                if (mid > 0 && end > mid) {
                    flush()
                    out += MdInline.Link(inline(text.substring(i + 1, mid)), text.substring(mid + 2, end).trim())
                    i = end + 1
                    continue
                }
            }
            plain.append(ch)
            i++
        }
        flush()
        return out
    }
}