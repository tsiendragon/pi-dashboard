package com.sam.pidash

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.live.ComposerPill
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** One pill, two inline actions: attach on the left, send on the right, never outside the field. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class ComposerPillTest {
    @get:Rule val compose = createComposeRule()
    private var sends = 0
    private var typed = ""

    private fun fixture(initial: String = "", canSend: Boolean = false, enabled: Boolean = true,
                        dark: Boolean = false, scale: Float = 1f, width: Int? = null) {
        compose.setContent {
            var draft by remember { mutableStateOf(initial) }
            typed = draft
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale)) {
                PiDashTheme(darkTheme = dark) {
                    Surface {
                        Column(
                            Modifier.fillMaxWidth().then(if (width != null) Modifier.width(width.dp) else Modifier)
                                .padding(8.dp),
                        ) {
                            ComposerPill(
                                draft = draft,
                                onDraftChange = { draft = it; typed = it },
                                enabled = enabled,
                                canSend = canSend,
                                onSend = { sends++ },
                                onFocusChange = {},
                                maxHeight = 180.dp,
                            ) {
                                IconButton(onClick = {}, modifier = Modifier.size(44.dp).testTag("leading")) {
                                    Icon(Icons.Filled.Add, "附加内容", Modifier.size(22.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @Test fun attachAndSendLiveInsideThePillAndTheFieldSitsBetweenThem() {
        fixture(initial = "继续")
        val lead = compose.onNodeWithTag("leading").getUnclippedBoundsInRoot()
        val field = compose.onNodeWithTag("composer-field").getUnclippedBoundsInRoot()
        val send = compose.onNodeWithTag("composer-send").getUnclippedBoundsInRoot()
        assertTrue("attach must precede the field", lead.right <= field.left)
        assertTrue("send must follow the field", field.right <= send.left)
        compose.onNodeWithContentDescription("附加内容").assertIsDisplayed()
        compose.onNodeWithContentDescription("发送").assertIsDisplayed()
        compose.onNodeWithText("继续").assertIsDisplayed()
    }
    @Test fun placeholderOnlyWhenEmptyAndTypingNeverSwapsTheSendAction() {
        fixture()
        compose.onNodeWithText("输入消息…").assertIsDisplayed()
        compose.onNodeWithTag("composer-field").performTextInput("你好")
        compose.onNodeWithText("输入消息…").assertDoesNotExist()
        compose.runOnIdle { assertEquals("你好", typed) }
        compose.onNodeWithContentDescription("发送").assertExists()
    }
    @Test fun emptyDraftKeepsSendDisabled() {
        fixture(initial = "", canSend = false)
        compose.onNodeWithTag("composer-send").assertIsNotEnabled()
    }
    @Test fun tappingSendFiresExactlyOnce() {
        fixture(initial = "可以发送", canSend = true)
        compose.onNodeWithTag("composer-send").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, sends) }
    }
    @Test fun disabledComposerStillShowsItsControls() {
        fixture(initial = "草稿", enabled = false)
        compose.onNodeWithTag("composer-field").assertIsNotEnabled()
        compose.onNodeWithContentDescription("附加内容").assertIsDisplayed()
    }
    @Test fun pillScreenshot() {
        fixture(initial = ""); compose.onRoot().captureRoboImage("src/test/screenshots/composer-pill.png")
    }
    @Test fun pillTypedScreenshot() {
        fixture(initial = "帮我把会话页的输入框改成一体化胶囊，加号和发送都放在里面。", canSend = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/composer-pill-typed.png")
    }
    @Test fun pillDarkScreenshot() {
        fixture(initial = "再核对一下长草稿的换行。", canSend = true, dark = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/composer-pill-dark.png")
    }
    @Test fun pillLargeFontScreenshot() {
        fixture(initial = "200% 字号下输入框仍然可用。", canSend = true, scale = 2f)
        compose.onRoot().captureRoboImage("src/test/screenshots/composer-pill-large-font.png")
    }
    @Test @Config(qualifiers = "w600dp-h800dp-xhdpi") fun pillWideScreenshot() {
        fixture(initial = "宽屏保持单行胶囊。", canSend = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/composer-pill-wide.png")
    }
}