package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.data.remote.LiveSubagentRecord
import com.sam.pidash.data.remote.LiveSubagentWorkflow
import com.sam.pidash.data.remote.LiveWorkflowRecord
import com.sam.pidash.domain.model.LiveBackgroundSnapshot
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The status bar must say what is running even when the main agent itself is idle. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class LiveWorkStatusBarScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val work = LiveSubagentWorkflow(
        agents = listOf(
            LiveSubagentRecord("agent-1", "核对登录流程", "running"),
            LiveSubagentRecord("agent-2", "等待确认", "blocked", needsAttention = true),
        ),
        workflows = listOf(
            LiveWorkflowRecord(
                "wf-1", "发布检查", "running",
                currentStage = 0, stageCount = 2, taskTotal = 3, taskDone = 1,
            ),
        ),
        agentsTotal = 2,
        agentsRunning = 1,
        agentsAttention = 1,
        workflowsTotal = 1,
        workflowsActive = 1,
    )

    private fun render(dark: Boolean, onOpen: () -> Unit = {}) {
        val state = liveWorkState("idle", true, LiveBackgroundSnapshot(), subagentWorkflow = work)
        compose.setContent {
            PiDashTheme(darkTheme = dark) {
                Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface) {
                    Column(Modifier.padding(vertical = 8.dp)) {
                        LiveWorkStatusBar(
                            state = state,
                            canOpenBackground = false,
                            onOpenBackground = {},
                            onOpenSubagentWorkflow = onOpen,
                        )
                    }
                }
            }
        }
    }

    @Test fun idleMainAgentStillNamesSubagentAndWorkflowWork() {
        var opened = false
        render(dark = false) { opened = true }
        compose.onNodeWithText("1 个子 Agent 运行中", substring = true).performClick()
        assertTrue(opened)
        compose.onRoot().captureRoboImage("src/test/screenshots/work-status-subagent.png")
    }

    @Test fun darkScreenshot() {
        render(dark = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/work-status-subagent-dark.png")
    }
}
