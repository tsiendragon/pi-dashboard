package com.sam.pidash

import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.data.remote.LiveSubagentWork
import com.sam.pidash.data.remote.LiveWorkCounts
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.ui.live.LiveWorkStatusBar
import com.sam.pidash.ui.live.liveWorkState
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class LiveWorkStatusUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun nonBashStatusIsSeparateFromTheBashActionAndHidesOnDisconnect() {
        val connected = mutableStateOf(true)
        val background = LiveBackgroundSnapshot()
        val work = LiveSubagentWork(LiveWorkCounts(1, 0), LiveWorkCounts(0, 1))
        val label = "后台（非 Bash）：子 Agent 1 个运行中 · 工作流 1 个排队"
        compose.setContent {
            PiDashTheme {
                Surface {
                    LiveWorkStatusBar(
                        state = liveWorkState("idle", connected.value, background, subagentWork = work),
                        canOpenBackground = true,
                        onOpenBackground = {},
                    )
                }
            }
        }
        compose.onNodeWithText("无后台命令运行").assertHasClickAction()
        compose.onNodeWithText(label).assertIsDisplayed().assertHasNoClickAction()

        compose.runOnIdle { connected.value = false }
        compose.onNodeWithText(label).assertDoesNotExist()
        compose.onNodeWithText("后台记录").assertHasClickAction()
    }
}
