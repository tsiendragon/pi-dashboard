package com.sam.pidash

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.ui.live.LocalServerCommandRunner
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class MarkdownRunCommandTest {
    @get:Rule val compose = createComposeRule()
    private val runs = mutableListOf<String>()

    private fun fixture(markdown: String, runner: ((String) -> Unit)? = { runs += it }) {
        compose.setContent {
            PiDashTheme {
                CompositionLocalProvider(LocalServerCommandRunner provides runner) {
                    MarkdownBody(markdown)
                }
            }
        }
    }

    @Test fun aShellBlockOffersRunWithItsExactCommand() {
        fixture("```bash\npython3 set-verify-credentials.py\n```")
        compose.onNodeWithText("运行").performClick()
        assertEquals(listOf("python3 set-verify-credentials.py"), runs)
    }

    @Test fun nonShellBlocksStayReadOnly() {
        fixture("```text\necho not-a-command\n```")
        compose.onNodeWithText("运行").assertDoesNotExist()
        compose.onNodeWithText("复制").assertExists()
    }

    @Test fun outsideALiveSessionThereIsNoRunAction() {
        fixture("```bash\necho hi\n```", runner = null)
        compose.onNodeWithText("运行").assertDoesNotExist()
    }

}
