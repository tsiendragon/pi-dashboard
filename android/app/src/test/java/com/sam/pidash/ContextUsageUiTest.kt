package com.sam.pidash

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.LiveContextUsage
import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.ui.live.ContextUsageSummary
import com.sam.pidash.ui.live.SudoApprovalDialog
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-xhdpi")
class ContextUsageUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun knownContext() {
        compose.setContent { PiDashTheme { Surface { ContextUsageSummary(LiveContextUsage(123456, 1000000, 12.3456)) } } }
        compose.onNodeWithText("123,456 / 1,000,000 tokens").assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/context-usage.png")
    }
    @Test fun cachedContextDark() {
        compose.setContent { PiDashTheme(darkTheme = true) { Surface { ContextUsageSummary(LiveContextUsage(90000, 100000, 90.0), cached = true) } } }
        compose.onNodeWithText("本机缓存，非实时 · 非累计用量").assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/context-usage-cached-dark.png")
    }
    @Test fun contextAtTwoHundredPercentFont() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) {
                PiDashTheme { Surface { ContextUsageSummary(LiveContextUsage(123456, 1000000, 12.3456)) } }
            }
        }
        compose.onNodeWithText("123,456 / 1,000,000 tokens").assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/context-usage-large-font.png")
    }
    @Test fun unknownUsageWorksInsideRealQuickMenu() {
        val usage = mutableStateOf<LiveContextUsage?>(null)
        compose.setContent { PiDashTheme { Box { DropdownMenu(expanded = true, onDismissRequest = {}) { ContextUsageSummary(usage.value) } } } }
        compose.onNodeWithText("上下文 · 占用待上报").assertIsDisplayed()
        compose.onNodeWithText("tokens 与窗口尚未上报").assertIsDisplayed()
        compose.onNodeWithText("0.0%", substring = true).assertDoesNotExist()
        compose.runOnIdle { usage.value = LiveContextUsage(50, 100, 50.0) }
        compose.onNodeWithText("50 / 100 tokens").assertIsDisplayed()
    }
    @Test fun incompleteSudoRequestIsCancelledOnceWithoutPassword() {
        var calls = 0
        val request = request().copy(message = null)
        compose.setContent { PiDashTheme { SudoApprovalDialog(request) { password, cancelled ->
            calls++; assertNull(password); assertTrue(cancelled); Result.success(Unit)
        } } }
        compose.runOnIdle { assertEquals(1, calls) }
        compose.mainClock.advanceTimeBy(1000)
        compose.runOnIdle { assertEquals(1, calls) }
        compose.onNodeWithText("密码", substring = true).assertDoesNotExist()
    }
    @Test fun failedInvalidRequestCancellationNeverRetriesOrOpensPasswordDialog() {
        var calls = 0
        val request = request().copy(message = null)
        compose.setContent { PiDashTheme { SudoApprovalDialog(request) { password, cancelled ->
            calls++; assertNull(password); assertTrue(cancelled); Result.failure(IllegalStateException("synthetic offline"))
        } } }
        compose.mainClock.advanceTimeBy(1000)
        compose.runOnIdle { assertEquals(1, calls) }
        compose.onNodeWithText("密码", substring = true).assertDoesNotExist()
        assertTrue(org.robolectric.shadows.ShadowToast.getTextOfLatestToast().orEmpty().contains("取消未确认送达"))
    }
    @Test fun completeSudoRequestNeverAutoApprovesOrCancels() {
        var calls = 0
        compose.setContent { PiDashTheme { SudoApprovalDialog(request()) { _, _ -> calls++; Result.success(Unit) } } }
        compose.runOnIdle { assertEquals(0, calls) }
    }
    private fun request() = LiveUiRequest(id = "synthetic-only", method = "sudo", message = "查看 UID，不修改文件。",
        command = "[\"/usr/bin/id\",\"-u\"]", host = "fixture-host", cwd = "/tmp", expiresAt = System.currentTimeMillis() + 120000)
}
