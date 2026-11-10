package com.sam.pidash

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.live.ApprovalCard
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The approval card replaces the old auto-popup: the agent's question stays visible above
 * the composer until it is answered, and only a confirm can be settled in place.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class ApprovalCardTest {
    @get:Rule val compose = createComposeRule()

    private var allowed = 0
    private var denied = 0
    private var opened = 0

    private fun fixture(
        method: String = "confirm",
        title: String = "允许运行：rm -rf build",
        message: String? = "删除构建目录，影响 /srv/projects/demo。",
        pendingCount: Int = 1,
        busy: Boolean = false,
        error: String? = null,
        dark: Boolean = false,
        scale: Float = 1f,
        shot: String? = null,
    ) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale)) {
                PiDashTheme(darkTheme = dark) {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            ApprovalCard(
                                method = method, title = title, message = message, pendingCount = pendingCount,
                                busy = busy, error = error,
                                onAllow = { allowed++ }, onDeny = { denied++ }, onOpen = { opened++ },
                            )
                        }
                    }
                }
            }
        }
        shot?.let { compose.onRoot().captureRoboImage("src/test/screenshots/$it.png") }
    }

    @Test fun aConfirmOffersAllowAndDeny() {
        fixture()
        compose.onNodeWithText("需要你处理").assertIsDisplayed()
        compose.onNodeWithText("允许运行：rm -rf build").assertIsDisplayed()
        compose.onNodeWithText("允许").performClick()
        compose.onNodeWithText("拒绝").performClick()
        assertEquals(1, allowed)
        assertEquals(1, denied)
        assertEquals(0, opened)
    }

    @Test fun sudoOnlyOpensTheSecureDialog() {
        fixture(method = "sudo", title = "需要管理员密码", message = null)
        compose.onNodeWithText("查看授权").performClick()
        compose.onNodeWithText("拒绝").assertDoesNotExist()
        assertEquals(1, opened)
        assertEquals(0, allowed)
    }

    @Test fun freeTextRequestsOpenTheDialog() {
        fixture(method = "input", title = "分支名？", message = null)
        compose.onNodeWithText("去回答").performClick()
        assertEquals(1, opened)
    }

    @Test fun additionalPendingRequestsAreCounted() {
        fixture(pendingCount = 3)
        compose.onNodeWithText("还有 2 个").assertIsDisplayed()
    }

    @Test fun aFailedAnswerStaysVisibleNextToTheRequest() {
        fixture(error = "请求已失效或已在其他端处理")
        compose.onNodeWithText("请求已失效或已在其他端处理").assertIsDisplayed()
    }

    @Test fun buttonsStayTappableAndDisabledWhileBusy() {
        fixture(busy = true)
        compose.onNodeWithText("允许").assertIsNotEnabled()
        compose.onNodeWithText("拒绝").assertIsNotEnabled()
        compose.onNodeWithText("允许").assertHeightIsAtLeast(48.dp)
    }

    @Test fun rendersAtTwoHundredPercentAndInDarkMode() {
        fixture(title = "允许运行：git push", message = "推送到远端分支 feature/approval-card。", scale = 2f, shot = "approval-card-large-font")
        compose.onNodeWithText("允许").assertIsDisplayed()
        assertEquals(0, allowed)
    }

    @Test fun darkShot() {
        fixture(dark = true, shot = "approval-card-dark")
        compose.onNodeWithText("需要你处理").assertIsDisplayed()
    }

    @Test fun lightShot() {
        fixture(shot = "approval-card")
        compose.onNodeWithText("需要你处理").assertIsDisplayed()
    }
}