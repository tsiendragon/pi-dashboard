package com.sam.pidash

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.ActivityDetailRow
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.live.DetailTraceBlock
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Real detail trace component; fictional paths and transcript, no server or device state. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h720dp-xhdpi")
class DetailTraceStyleTest {
    @get:Rule val compose = createComposeRule()
    private val firstThought = "读取扩展源码，确认现有 sudo 参数结构。"
    private val tail = "接下来核对测试和发布产物。\n独立思考的第二段仍完整保留。"
    private fun thought(id: String, text: String) = LiveTimelineItem(id, "assistant", "", thinking = text)
    private fun tool(id: String, name: String, arg: String, error: Boolean = false) = LiveTimelineItem(
        id, "tool", if (error) "测试尚未通过，需要检查错误。" else "读取完成。", toolName = name,
        toolCallId = id, toolArgs = arg, status = if (error) "error" else "done", isError = error)
    private fun items() = listOf(
        thought("t1", firstThought), tool("c1", "read", """{"path":"/workspace/project/src/sudo.ts"}"""),
        thought("t2", "检索注册入口，核对参数定义。"), tool("c2", "bash", """{"command":"rg -n sudo_exec src"}"""),
        thought("t3", "参数校验应发生在授权请求之前。"), tool("c3", "edit", """{"path":"/workspace/project/src/index.ts"}"""),
        thought("t4", "确认测试错误后再决定如何修复。"), tool("c4", "bash", """{"command":"npm test"}""", error = true),
        thought("tail", tail),
    )
    private fun fixture(dark: Boolean = false, scale: Float = 1f) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = scale)) {
                PiDashTheme(darkTheme = dark) {
                    var expanded by remember { mutableStateOf(true) }
                    Surface {
                        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp)) {
                            DetailTraceBlock(ActivityDetailRow.Trace(items()), expanded, { expanded = !expanded }, {}, {})
                        }
                    }
                }
            }
        }
    }
    private fun capture(name: String) { compose.onRoot().captureRoboImage("src/test/screenshots/$name.png") }

    @Test fun compactLight() { fixture(); capture("detail-trace-light") }
    @Test fun compactDark() { fixture(dark = true); capture("detail-trace-dark") }
    @Test fun compactLargeFont() {
        fixture(scale = 2f)
        compose.onNodeWithText("收起").assertIsDisplayed()
        compose.onNodeWithText("1 失败").assertIsDisplayed()
        capture("detail-trace-large-font")
    }
    @Test @Config(qualifiers = "w600dp-h800dp-xhdpi")
    fun compactWide() { fixture(); capture("detail-trace-wide") }
    @Test fun expandedRecord() {
        fixture()
        compose.onAllNodesWithContentDescription("展开记录")[0].performClick()
        compose.onNodeWithText(firstThought).assertIsDisplayed()
        compose.onNodeWithText("执行前思考").assertIsDisplayed()
        compose.onNodeWithText("参数").assertIsDisplayed()
        compose.onNodeWithText("输出").assertIsDisplayed()
        capture("detail-trace-expanded")
    }
    @Test fun rowCountsAndTouchTargetsStayHonest() {
        fixture()
        compose.onNodeWithText("4 步 · 5 段思考").assertExists()
        compose.onNodeWithText("1 失败").assertExists()
        compose.onAllNodesWithContentDescription("展开记录").assertCountEquals(4)
        compose.onAllNodesWithContentDescription("展开记录").fetchSemanticsNodes().indices.forEach {
            compose.onAllNodesWithContentDescription("展开记录")[it].assertHeightIsAtLeast(48.dp)
        }
        compose.onNodeWithText(firstThought).assertDoesNotExist()
    }
    @Test fun standaloneThinkingKeepsItsPreviewAndFullOriginalText() {
        fixture()
        compose.onNodeWithText(tail.lineSequence().first()).performClick()
        compose.onNodeWithText(tail).assertIsDisplayed()
    }
    @Test fun closingAndReopeningTraceKeepsRecordsAvailable() {
        fixture()
        compose.onNodeWithText("执行记录").performClick()
        compose.onAllNodesWithContentDescription("展开记录").assertCountEquals(0)
        compose.onNodeWithText("执行记录").performClick()
        compose.onAllNodesWithContentDescription("展开记录").assertCountEquals(4)
    }
}
