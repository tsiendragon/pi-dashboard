package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoicePolishTest {
    private fun message(id: String, role: String, text: String) = LiveTimelineItem(id, role, text)
    private fun summary() = LiveSummary(
        processInstanceId = "p", sessionId = "s", cwd = "/work/app",
        canonicalCwd = "/work/app", sessionName = "修复登录",
    )

    @Test fun sendsOnlyASmallRecentProseWindowAndTheDraft() {
        val context = voicePolishContext(
            summary(),
            listOf(
                message("tool", "tool", "tool output must not be sent"),
                message("u1", "user", "第一问"),
                message("a1", "assistant", "第一答"),
                message("tool2", "tool", "secret tool output"),
                message("u2", "user", "第二问"),
                message("a2", "assistant", "第二答"),
                message("u3", "user", "第三问"),
            ),
            "当前草稿",
        )!!
        assertEquals("修复登录", context.title)
        assertEquals("/work/app", context.cwd)
        assertEquals("当前草稿", context.draft)
        assertEquals(listOf("第二问", "第二答", "第三问"), context.recent.map { it.text })
        assertTrue(context.recent.all { it.role == "assistant" || it.role == "user" })
    }

    @Test fun asrContextIncludesTechnicalTermsAndRecentProseButNotTools() {
        val context = voiceAsrContext(
            summary(),
            listOf(
                message("tool", "tool", "not sent"),
                message("u1", "user", "检查 WebSocket 的 session"),
                message("a1", "assistant", "看 API 和 canonicalCwd"),
            ),
            "继续检查 sudo 路径",
        )!!
        assertTrue(context.contains("技术词"))
        assertTrue(context.contains("WebSocket"))
        assertTrue(context.contains("canonicalCwd"))
        assertTrue(context.contains("检查 WebSocket 的 session"))
        assertTrue(context.contains("继续检查 sudo 路径"))
        assertTrue(!context.contains("not sent"))
    }

    @Test fun asrContextCanBeDisabled() {
        assertNull(voiceAsrContext(summary(), emptyList(), "draft", includeContext = false))
    }

    @Test fun optOutSendsNoContextAndEmptySessionsReturnNull() {
        assertNull(voicePolishContext(summary(), emptyList(), "draft", includeContext = false))
        assertNull(voicePolishContext(null, emptyList(), ""))
    }
}
