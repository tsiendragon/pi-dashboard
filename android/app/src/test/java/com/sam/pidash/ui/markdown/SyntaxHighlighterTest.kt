package com.sam.pidash.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyntaxHighlighterTest {
    private fun kinds(code: String, language: String?) =
        SyntaxHighlighter.highlight(code, language).map { it.kind to code.substring(it.start, it.end) }

    @Test fun kotlinKeywordsStringsAndComments() {
        val code = "fun main() {\n  val x = \"hi\" // note\n}"
        val tokens = kinds(code, "kotlin")
        assertTrue(tokens.contains(CodeTokenKind.Keyword to "fun"))
        assertTrue(tokens.contains(CodeTokenKind.Function to "main"))
        assertTrue(tokens.contains(CodeTokenKind.Keyword to "val"))
        assertTrue(tokens.contains(CodeTokenKind.String to "\"hi\""))
        assertTrue(tokens.contains(CodeTokenKind.Comment to "// note"))
    }

    @Test fun escapesKeepTheStringTogether() {
        val tokens = kinds("val s = \"a\\\"b\" + 1", "kotlin")
        assertTrue(tokens.contains(CodeTokenKind.String to "\"a\\\"b\""))
        assertTrue(tokens.contains(CodeTokenKind.Number to "1"))
    }

    @Test fun pythonHashesAndTripleQuotesAreCommentsAndStrings() {
        val py = "def f():\n    \"\"\"doc\"\"\"\n    return 1  # done"
        val tokens = kinds(py, "python")
        assertTrue(tokens.contains(CodeTokenKind.Keyword to "def"))
        assertTrue(tokens.contains(CodeTokenKind.String to "\"\"\"doc\"\"\""))
        assertTrue(tokens.contains(CodeTokenKind.Comment to "# done"))
    }

    @Test fun bashTreatsHashAsComment() {
        val tokens = kinds("cd /tmp # go\nls -la", "bash")
        assertTrue(tokens.contains(CodeTokenKind.Comment to "# go"))
        assertTrue(tokens.contains(CodeTokenKind.Keyword to "cd"))
    }

    @Test fun jsonOnlyHighlightsLiteralsAndStrings() {
        val tokens = kinds("{\"a\": true, \"b\": null}", "json")
        assertTrue(tokens.contains(CodeTokenKind.String to "\"a\""))
        assertTrue(tokens.contains(CodeTokenKind.Keyword to "true"))
        assertTrue(tokens.contains(CodeTokenKind.Keyword to "null"))
    }

    @Test fun plainBlocksAndUnknownLanguagesWithoutStructureStayUncoloured() {
        assertTrue(SyntaxHighlighter.highlight("whatever", null).isEmpty())
        assertTrue(SyntaxHighlighter.highlight("whatever", "text").isEmpty())
        assertTrue(SyntaxHighlighter.highlight("whatever", "log").isEmpty())
        // An unrecognised language still gets generic strings/comments rather than raw noise.
        assertTrue(SyntaxHighlighter.highlight("x(\"s\")", "elixir").isNotEmpty())
    }

    @Test fun hugeBlocksAreNotHighlighted() {
        assertTrue(SyntaxHighlighter.highlight("a".repeat(SyntaxHighlighter.MAX_CHARS + 1), "kotlin").isEmpty())
    }

    @Test fun unclosedStringAndBlockCommentStopAtTheEnd() {
        assertTrue(kinds("val a = \"unclosed", "kotlin").contains(CodeTokenKind.String to "\"unclosed"))
        assertTrue(kinds("/* open", "kotlin").contains(CodeTokenKind.Comment to "/* open"))
    }

    @Test fun tokensNeverOverlapOrExceedTheCode() {
        val code = "fun f(a: Int) = \"x\" // c"
        val tokens = SyntaxHighlighter.highlight(code, "kotlin")
        var last = 0
        tokens.forEach { token ->
            assertTrue("monotonic", token.start >= last)
            assertTrue("in range", token.end <= code.length)
            last = token.end
        }
        assertEquals(tokens.sortedBy { it.start }, tokens)
    }
}
