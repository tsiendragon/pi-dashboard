package com.sam.pidash.domain.model

import org.junit.Assert.*
import org.junit.Test

class WholeMessageTextTest {
    private fun item(text: String = "", role: String = "assistant", thinking: String? = null) =
        LiveTimelineItem("id", role, text, thinking = thinking)

    @Test fun plainBodyRemainsExactIncludingWhitespaceAndMarkdown() {
        val raw = "  **正文**\n\t尾部  "
        assertEquals(raw, wholeMessageText(item(raw)))
    }
    @Test fun thinkingAndBodyPreserveEveryCharacter() {
        assertEquals("【思考】\n  思考\n思考  \n\n【正文】\n 正文  ",
            wholeMessageText(item(" 正文  ", thinking = "  思考\n思考  ")))
    }
    @Test fun activityPreservesChronologyRepeatedThinkingAndAllReplies() {
        val items = listOf(item("请求", "user"), item(thinking = "重复"),
            item("中间回复"), item(thinking = "重复"),
            item("  输出\n尾行 ", "tool").copy(toolName = "bash", toolArgs = "{\"command\":\"pwd\"}"),
            item("最终回复"))
        assertEquals("【用户请求】\n请求\n\n【助手消息】\n【思考】\n重复\n\n" +
            "【助手消息】\n中间回复\n\n【助手消息】\n【思考】\n重复\n\n" +
            "【工具：bash】\n\n状态：done\n\n【参数】\n{\"command\":\"pwd\"}\n\n【输出】\n  输出\n尾行 \n\n" +
            "【助手消息】\n最终回复", wholeActivityText(items))
    }
    @Test fun hugeParametersAndHiddenTailAreNotTruncated() {
        val args = "x".repeat(70000) + "TAIL"
        val text = wholeMessageText(item("output", "tool").copy(toolArgs = args, toolName = "write"))
        assertTrue(text.contains(args)); assertTrue(text.endsWith("output"))
    }
    @Test fun imagesAreHonestPlaceholdersWithoutBinaryData() {
        val raw = wholeMessageText(item().copy(images = listOf(LiveImage("image/png", "DO_NOT_EXPORT_IMAGE_BYTES"))))
        assertEquals("[包含 1 张图片，图片本体未复制]", raw)
        assertFalse(raw.contains("DO_NOT_EXPORT_IMAGE_BYTES"))
    }
    @Test fun emptyEntriesDoNotProduceEmptyRoleHeadings() {
        assertEquals("", wholeActivityText(emptyList()))
        assertEquals("", wholeActivityText(listOf(item(), item(thinking = ""))))
    }
    @Test fun failedAndRunningToolsNeverBecomeSuccessful() {
        val failed = wholeMessageText(item("原始错误", "tool").copy(toolName = "bash", isError = true))
        assertTrue(failed.contains("状态：失败")); assertTrue(failed.contains("原始错误"))
        val running = wholeMessageText(item(role = "tool").copy(toolName = "bash", status = "running"))
        assertTrue(running.contains("状态：running")); assertFalse(running.contains("done"))
    }
    @Test fun unknownRolesDoNotBecomeAssistantReplies() {
        assertEquals("【记录：system】\n提示", wholeActivityText(listOf(item("提示", "system"))))
    }
}
