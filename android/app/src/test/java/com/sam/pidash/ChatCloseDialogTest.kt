package com.sam.pidash

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.ui.chat.ChatCloseDialog
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class ChatCloseDialogTest {
    @get:Rule val compose = createComposeRule()
    private var confirmed = 0
    private var dismissed = 0

    private fun fixture(closing: Boolean = false, error: String? = null) {
        compose.setContent {
            PiDashTheme {
                ChatCloseDialog(closing, error, { dismissed++ }, { confirmed++ })
            }
        }
    }

    @Test fun explainsWhatClosingDoesAndDoesNotDo() {
        fixture()
        compose.onNodeWithText("关闭这个 Chat 会话？").assertIsDisplayed()
        compose.onNodeWithText("正在生成的回复会被中断", substring = true).assertIsDisplayed()
        compose.onNodeWithText("已保存到磁盘的会话记录不会被删除", substring = true).assertIsDisplayed()
    }
    @Test fun confirmAndCancelFireTheirOwnCallbacks() {
        fixture()
        compose.onNodeWithText("关闭会话").performClick()
        compose.runOnIdle { assertEquals(1, confirmed) }
        compose.onNodeWithText("取消").performClick()
        compose.runOnIdle { assertEquals(1, dismissed) }
    }
    @Test fun busyStateShowsProgressAndBlocksBothButtons() {
        fixture(closing = true)
        compose.onNodeWithText("正在关闭…").assertIsNotEnabled()
        compose.onNodeWithText("取消").assertIsNotEnabled()
    }
    @Test fun failureReasonIsShownSoTheUserIsNotToldItClosed() {
        fixture(error = "HTTP 500: boom")
        compose.onNodeWithText("HTTP 500: boom").assertIsDisplayed()
    }
    @Test fun dialogKeepsTheUnifiedTitleStyleAndShape() {
        fixture()
        // One 15 sp semi-bold title, matching page headers; the body keeps reading size.
        compose.onNodeWithText("关闭这个 Chat 会话？").assertIsDisplayed()
        compose.onNodeWithText("取消").assertIsDisplayed()
    }
}
