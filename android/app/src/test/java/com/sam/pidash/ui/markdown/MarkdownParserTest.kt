package com.sam.pidash.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {
    @Test fun headingsCodeAndRulesKeepTheirStructure() {
        val blocks = MarkdownParser.parse("# Title\n\n```kotlin\nval a = 1\n```\n\n---")
        assertEquals(MdBlock.Heading(1, "Title"), blocks[0])
        assertEquals(MdBlock.Code("kotlin", "val a = 1"), blocks[1])
        assertEquals(MdBlock.Rule, blocks[2])
    }

    @Test fun unclosedFenceStillBecomesCode() {
        assertEquals(MdBlock.Code(null, "still typing"), MarkdownParser.parse("```\nstill typing").single())
    }

    @Test fun bulletAndOrderedListsKeepDepthAndStart() {
        val bullets = MarkdownParser.parse("- one\n  - nested\n- two").single() as MdBlock.Bullets
        assertEquals(listOf(0, 1, 0), bullets.items.map { it.depth })
        assertEquals(listOf("one", "nested", "two"), bullets.items.map { it.text })
        val ordered = MarkdownParser.parse("3. third\n4. fourth").single() as MdBlock.Bullets
        assertTrue(ordered.ordered)
        assertEquals(3, ordered.start)
    }

    @Test fun tablesNeedADividerRowAndSplitCells() {
        val table = MarkdownParser.parse("| a | b |\n| --- | :-: |\n| 1 | 2 |").single() as MdBlock.Table
        assertEquals(listOf("a", "b"), table.header)
        assertEquals(listOf(listOf("1", "2")), table.rows)
        assertEquals(listOf("start", "center"), table.align)
        assertTrue(MarkdownParser.parse("just | text").single() is MdBlock.Paragraph)
    }

    @Test fun quotesNestTheirOwnBlocks() {
        val quote = MarkdownParser.parse("> quoted **bold**\n> more").single() as MdBlock.Quote
        assertTrue(quote.blocks.first() is MdBlock.Paragraph)
    }

    @Test fun inlineEmphasisCodeLinksAndStrike() {
        val parsed = MarkdownParser.inline("a **b** *c* ~~d~~ `e` [f](https://x.test)")
        val kinds = parsed.mapNotNull {
            when (it) {
                is MdInline.Text -> if (it.value.isBlank()) null else "text"
                is MdInline.Strong -> "strong"
                is MdInline.Em -> "em"
                is MdInline.Strike -> "strike"
                is MdInline.Code -> "code"
                is MdInline.Link -> "link"
            }
        }
        assertEquals(listOf("text", "strong", "em", "strike", "code", "link"), kinds)
        assertEquals("b", ((parsed.first { it is MdInline.Strong } as MdInline.Strong).children.single() as MdInline.Text).value)
        val link = parsed.filterIsInstance<MdInline.Link>().single()
        assertEquals("https://x.test", link.href)
        assertEquals("f", (link.children.single() as MdInline.Text).value)
        assertEquals("e", parsed.filterIsInstance<MdInline.Code>().single().value)
    }

    @Test fun codeWinsInsideBackticksAndUnclosedMarkersStayLiteral() {
        val parsed = MarkdownParser.inline("`**not bold**` and **open")
        assertEquals("**not bold**", (parsed[0] as MdInline.Code).value)
        assertTrue(parsed.drop(1).joinToString("") { (it as? MdInline.Text)?.value ?: "" }.contains("**open"))
    }

    @Test fun escapesAreHonoured() {
        val parsed = MarkdownParser.inline("a \\*not em\\* b")
        assertEquals("a *not em* b", parsed.joinToString("") { (it as? MdInline.Text)?.value ?: "" })
    }

    @Test fun blankInputIsEmptyNotCrashing() {
        assertTrue(MarkdownParser.parse("").isEmpty())
        assertTrue(MarkdownParser.inline("").isEmpty())
    }
}
