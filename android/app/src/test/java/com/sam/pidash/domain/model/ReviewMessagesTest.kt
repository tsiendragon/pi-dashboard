package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The App must produce exactly the bytes the WebUI writes for quotes and comments. */
class ReviewMessagesTest {
    @Test fun quotesAreCollapsedAndCappedLikeTheWebUi() {
        assertEquals("a b c", normalizeQuote("  a\n b\tc  "))
        assertEquals(null, normalizeQuote("   "))
        assertEquals(null, normalizeQuote(null))
        val long = "x".repeat(MAX_QUOTE_CHARS + 20)
        val capped = normalizeQuote(long)!!
        assertEquals(MAX_QUOTE_CHARS, capped.length)
        assertTrue(capped.endsWith("…"))
    }

    @Test fun speakerLabelsMatchTheWebUi() {
        assertEquals("你的回复", selectionLabel("assistant"))
        assertEquals("我的消息", selectionLabel("user"))
        assertEquals("会话内容", selectionLabel(null))
    }

    @Test fun quoteReplyUsesTheBlockquoteForm() {
        val text = quoteReplyMessage(
            listOf(AppQuote("q1", "先看目录", "assistant"), AppQuote("q2", "第二行\n第三行", "user"))
        )
        assertEquals(
            "引用（来自你的回复）：\n> 先看目录\n\n引用（来自我的消息）：\n> 第二行\n> 第三行",
            text,
        )
    }

    @Test fun reviewMessageNumbersItemsAndKeepsTheQuotedText() {
        val text = reviewMessage(listOf(AppReviewItem("c1", "你的回复", "先看目录", "这里应该用 ls -la")))
        assertEquals(
            "Please review and address these comments about the quoted parts of our conversation:\n\n" +
                "[1] 你的回复\nQuoted: \"先看目录\"\nComment: 这里应该用 ls -la",
            text,
        )
    }

    @Test fun outgoingMessageOrdersQuotesThenCommentsThenTypedText() {
        val text = composeOutgoing(
            "  顺便重跑测试  ",
            quotes = listOf(AppQuote("q1", "先看目录", "assistant")),
            reviews = listOf(AppReviewItem("c1", "我的消息", "跑一下", "要加 -x")),
        )
        assertEquals(
            "引用（来自你的回复）：\n> 先看目录\n\n" +
                "Please review and address these comments about the quoted parts of our conversation:\n\n" +
                "[1] 我的消息\nQuoted: \"跑一下\"\nComment: 要加 -x\n\n" +
                "顺便重跑测试",
            text,
        )
    }

    @Test fun plainTextIsUnchangedWhenNothingIsQuoted() {
        assertEquals("hello", composeOutgoing("  hello  "))
        assertEquals("", composeOutgoing("   "))
    }
}
