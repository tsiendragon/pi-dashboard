package com.sam.pidash

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class PiTextFieldTest {
    @get:Rule val compose = createComposeRule()
    private var text = ""

    private fun fixture(initial: String = "", enabled: Boolean = true, password: Boolean = false,
                        dark: Boolean = false, trailing: Boolean = false) {
        compose.setContent {
            var value by remember { mutableStateOf(initial) }
            text = value
            PiDashTheme(darkTheme = dark) {
                Surface {
                    Column(Modifier.padding(12.dp)) {
                        PiTextField(
                            value = value,
                            onValueChange = { value = it; text = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = "地址",
                            placeholder = "https://pi.example.com",
                            enabled = enabled,
                            isPassword = password,
                            supportingText = "只在本机保存。",
                            trailing = if (trailing) ({ TextButton(onClick = {}) { Text("清空") } }) else null,
                        )
                    }
                }
            }
        }
    }

    @Test fun labelSitsAboveTheFilledBoxAndPlaceholderOnlyWhenEmpty() {
        fixture()
        compose.onNodeWithText("地址").assertIsDisplayed()
        compose.onNodeWithText("https://pi.example.com").assertIsDisplayed()
        compose.onNodeWithText("只在本机保存。").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).performTextInput("hi")
        compose.onNodeWithText("https://pi.example.com").assertDoesNotExist()
        compose.runOnIdle { assertEquals("hi", text) }
    }
    @Test fun disabledFieldCannotBeEdited() {
        fixture(initial = "锁定", enabled = false)
        compose.onNodeWithText("锁定").assertIsNotEnabled().assertIsDisplayed()
    }
    @Test fun passwordIsMaskedButStillEditable() {
        fixture(password = true)
        compose.onNode(hasSetTextAction()).performTextInput("hunter2")
        compose.runOnIdle { assertEquals("hunter2", text) }
        compose.onNodeWithText("hunter2").assertDoesNotExist()
        compose.onNodeWithText("•••••••").assertExists()
    }
    @Test fun trailingActionStaysReachable() {
        fixture(trailing = true)
        compose.onNodeWithText("清空").assertIsDisplayed().performClick()
    }
    @Test fun lightScreenshot() { fixture(initial = "https://pi.example.com"); compose.onRoot().captureRoboImage("src/test/screenshots/pi-text-field.png") }
    @Test fun darkScreenshot() { fixture(password = true, dark = true); compose.onRoot().captureRoboImage("src/test/screenshots/pi-text-field-dark.png") }
}
