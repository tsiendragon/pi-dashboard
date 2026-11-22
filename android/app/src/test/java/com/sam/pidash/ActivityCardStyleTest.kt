package com.sam.pidash

import android.content.ClipboardManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.live.NativeActivityCard
import com.sam.pidash.ui.theme.PiDashTheme
import androidx.compose.runtime.CompositionLocalProvider
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The activity card shares its trace headers with the full-record page; check both look the same. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class ActivityCardStyleTest {
    @get:Rule val compose = createComposeRule()

    private fun msg(id: String, text: String = "", role: String = "assistant", thinking: String? = null) =
        LiveTimelineItem(id, role, text, thinking = thinking)
    private fun step(id: String, tool: String, args: String, output: String, error: Boolean = false, status: String = "done") =
        LiveTimelineItem(id, "tool", output, toolName = tool, toolCallId = "call-$id", toolArgs = args,
            isError = error, status = status)

    private fun activity() = LiveActivity(
        "turn", "本轮", "done",
        listOf(
            msg("u", "继续", "user"),
            msg("t1", thinking = "先读扩展源码，确认 sudo 参数结构。"),
            step("s1", "read", """{"path":"/workspace/project/src/sudo.ts"}""", "读取完成。"),
            step("s2", "bash", """{"command":"rg -n sudo_exec src"}""", "src/sudo.ts:41"),
            msg("t2", thinking = "再确认测试基线与失败原因。"),
            step("s3", "bash", """{"command":"npm test"}""", "1 failed", error = true),
            msg("a", "本轮在隔离副本中完成并验证了四组候选，主 frontend 750 项基线保持一致。", thinking = "汇总结果。"),
        ),
    )

    private fun fixture(dark: Boolean = false, scale: Float = 1f, width: Int? = null, activity: LiveActivity = activity()) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale)) {
                PiDashTheme(darkTheme = dark) {
                    Surface {
                        Column(
                            Modifier.fillMaxWidth().then(if (width != null) Modifier.width(width.dp) else Modifier)
                                .verticalScroll(rememberScrollState()).padding(12.dp),
                        ) { NativeActivityCard(activity, {}) }
                    }
                }
            }
        }
    }

    @Test fun traceHeadersShareOneShapeAndFailureIsAPill() {
        fixture()
        compose.onNodeWithText("执行步骤").assertExists()
        compose.onNodeWithText("思考过程").assertExists()
        compose.onNodeWithText("3 步").assertExists()
        compose.onNodeWithText("1 步失败").assertExists()
        compose.onNodeWithText("全部完成").assertDoesNotExist()
        // Both headers start folded; the counts and failure pill still summarize the hidden steps.
        compose.onNodeWithText("收起").assertDoesNotExist()
        compose.onAllNodesWithText("展开").assertCountEquals(2)
    }
    @Test fun stepsStartCollapsedAndExpandOnDemand() {
        fixture()
        compose.onAllNodesWithText("bash").assertCountEquals(0)
        compose.onNodeWithText("执行步骤").performClick()
        compose.onAllNodesWithText("bash").assertCountEquals(2)
        compose.onNodeWithText("执行步骤").performClick()
        compose.onAllNodesWithText("bash").assertCountEquals(0)
    }
    @Test fun commandOpensDetailsAndCopiesCommandAndOutputSeparately() {
        fixture()
        val command = "npm test"
        val clipboard = ApplicationProvider.getApplicationContext<Context>()
            .getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        compose.onNodeWithText("执行步骤").performClick()
        compose.onNodeWithText(command).performClick()
        compose.onNodeWithText("执行状态：失败").assertIsDisplayed()
        compose.onNodeWithText("1 failed").assertIsDisplayed()
        compose.onNodeWithText("复制命令").performClick()
        compose.runOnIdle { assertEquals(command, clipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        compose.onNodeWithText("复制输出").performClick()
        compose.runOnIdle { assertEquals("1 failed", clipboard.primaryClip?.getItemAt(0)?.text?.toString()) }
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithText("执行状态：失败").assertDoesNotExist()
    }

    @Test fun aRunningActivityAlsoStartsWithStepsCollapsed() {
        fixture(activity = activity().copy(state = "running"))
        compose.onAllNodesWithText("bash").assertCountEquals(0)
        compose.onNodeWithText("执行步骤").performClick()
        compose.onAllNodesWithText("bash").assertCountEquals(2)
    }

    @Test fun aStepOpensItsFullCommandInADialog() {
        fixture()
        compose.onNodeWithText("执行步骤").performClick()
        compose.onAllNodesWithText("bash")[0].performClick()
        compose.onNodeWithText("步骤详情").assertExists()
        // One copy in the collapsed row, one in the dialog's full command section.
        compose.onAllNodesWithText("rg -n sudo_exec src", substring = true).assertCountEquals(2)
    }

    @Test fun longStepListStaysInAFixedWindow() {
        val manySteps = LiveActivity(
            "many", "本轮", "done",
            listOf(msg("u", "继续", "user")) + (1..14).map { n ->
                step("s$n", "bash", """{"command":"echo step $n"}""", "step $n")
            },
        )
        fixture(activity = manySteps)
        compose.onNodeWithText("执行步骤").performClick()
        compose.onNodeWithTag("activity-steps-window").assertHeightIsEqualTo(480.dp)
    }

    @Test fun aThinkingLineOpensFullThinkingDialog() {
        fixture()
        compose.onNodeWithText("思考过程").performClick()
        compose.onAllNodesWithText("先读扩展源码，确认 sudo 参数结构。")[0].performClick()
        compose.onNodeWithText("思考详情").assertExists()
        compose.onAllNodesWithText("先读扩展源码，确认 sudo 参数结构。").assertCountEquals(2)
    }

    @Test fun hiddenThinkingRendersOneEmojiPerBlock() {
        val hidden = LiveActivity(
            "hidden", "本轮", "done",
            listOf(
                msg("u", "继续", "user"),
                msg("t", "").copy(thinkingBlocks = listOf("", "")),
                msg("a", "完成"),
            ),
        )
        fixture(activity = hidden)
        compose.onNodeWithText("思考过程").performClick()
        compose.onAllNodesWithText("🤔").assertCountEquals(2)
    }
    @Test fun expandedStepsScreenshot() {
        fixture()
        compose.onNodeWithText("执行步骤").performClick()
        compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-expanded.png")
    }

    @Test fun longStepsWindowScreenshot() {
        val manySteps = LiveActivity(
            "many", "本轮", "done",
            listOf(msg("u", "继续", "user")) + (1..14).map { n ->
                step("s$n", "bash", """{"command":"echo step $n"}""", "step $n")
            },
        )
        fixture(activity = manySteps)
        compose.onNodeWithText("执行步骤").performClick()
        compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-long-steps.png")
    }

    @Test fun thinkingWindowScreenshot() {
        fixture()
        compose.onNodeWithText("思考过程").performClick()
        compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-thinking.png")
    }

    @Test fun hiddenThinkingScreenshot() {
        val hidden = LiveActivity(
            "hidden", "本轮", "done",
            listOf(
                msg("u", "继续", "user"),
                msg("t", "").copy(thinkingBlocks = listOf("", "")),
                msg("a", "完成"),
            ),
        )
        fixture(activity = hidden)
        compose.onNodeWithText("思考过程").performClick()
        compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-hidden-thinking.png")
    }

    @Test fun expandedStepsDarkScreenshot() {
        fixture(dark = true)
        compose.onNodeWithText("执行步骤").performClick()
        compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-expanded-dark.png")
    }

    @Test fun headerScreenshot() {
        fixture(); compose.onRoot().captureRoboImage("src/test/screenshots/activity-card.png")
    }
    @Test fun headerDarkScreenshot() {
        fixture(dark = true); compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-dark.png")
    }
    @Test fun headerLargeFontScreenshot() {
        fixture(scale = 2f); compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-large-font.png")
    }
    @Test @Config(qualifiers = "w600dp-h800dp-xhdpi") fun headerWideScreenshot() {
        fixture(); compose.onRoot().captureRoboImage("src/test/screenshots/activity-card-wide.png")
    }
}