package com.sam.pidash

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.ui.common.CopyTextAction
import com.sam.pidash.ui.common.copyPlainText
import com.sam.pidash.ui.live.NativeActivityCard
import com.sam.pidash.ui.live.NativeMessageCard
import com.sam.pidash.ui.live.NativeStepCard
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import android.widget.Magnifier
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowToast

/** Uses the isolated Robolectric clipboard, never the host/phone clipboard. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi", shadows = [CopySelectionMagnifier::class])
class TextCopyTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var uiContext: Context
    private val toolbar = SelectionToolbar()
    private fun clipboard(context: Context = uiContext) = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private fun copied() = clipboard().primaryClip?.getItemAt(0)?.text?.toString()
    private fun fixture(scale: Float = 1f, dark: Boolean = false, content: @Composable () -> Unit) {
        compose.setContent {
            uiContext = LocalContext.current
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = scale), LocalTextToolbar provides toolbar) {
                PiDashTheme(darkTheme = dark) { Surface {
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp)) { content() }
                } }
            }
        }
    }
    private fun message(text: String, role: String = "assistant", thinking: String? = null) =
        LiveTimelineItem("message", role, text, thinking = thinking)
    private fun activity(reply: String, prompt: String = "请检查当前项目") = LiveActivity("turn", "本轮", "done", listOf(message(prompt, "user"), message(reply)))
    private fun tool(args: String = """{"path":"/workspace/demo.txt"}""", output: String = "  第一行输出\n第二行输出  ") =
        LiveTimelineItem("tool", "tool", output, toolName = "read", toolCallId = "call", toolArgs = args)
    private fun openTool() { compose.onNodeWithContentDescription("展开记录").performClick() }
    private fun longText() = (1..50).joinToString("\n") { "第 $it 行：保留完整原文" } + "\nTAIL_ONLY_IN_FULL_SOURCE"
    private fun pickActivityCopy(label: String) {
        compose.onNodeWithText("复制").performScrollTo().performClick()
        compose.onNodeWithText(label).performClick()
    }

    @Test fun readOnlyUserCopiesFullSourceNotPreview() {
        val text = longText()
        fixture { NativeMessageCard(message(text, "user"), {}, {}, compactUser = true, enabled = false) }
        compose.onNodeWithText("TAIL_ONLY_IN_FULL_SOURCE", substring = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("用户消息操作，可展开全文").performClick()
        compose.onNodeWithText("复制文字").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(text, copied()) }
    }
    @Test fun readOnlyAssistantCopiesFullBodyAndSeparateThinking() {
        val text = longText()
        val thought = "  思考原文\n保留换行  "
        fixture { NativeMessageCard(message(text, thinking = thought), {}, {}, compactAssistant = true, enabled = false) }
        compose.onNodeWithContentDescription("回复操作，可展开全文").performClick()
        compose.onNodeWithText("复制正文").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(text, copied()) }
        compose.onNodeWithContentDescription("回复操作，可展开全文").performClick()
        compose.onNodeWithText("复制思考").performClick()
        compose.runOnIdle { assertEquals(thought, copied()) }
    }
    @Test fun activityReplyCopyDoesNotNavigateAndIncludesHiddenTail() {
        var opens = 0
        val text = longText()
        fixture { NativeActivityCard(activity(text), { opens++ }) }
        pickActivityCopy("复制回复")
        compose.runOnIdle { assertEquals(0, opens); assertEquals(text, copied()) }
    }
    @Test fun activityRequestPreservesOriginalWhitespace() {
        val prompt = "  用户原始请求\n第二行  "
        fixture { NativeActivityCard(activity("回复", prompt), {}) }
        pickActivityCopy("复制请求")
        compose.runOnIdle { assertEquals(prompt, copied()) }
    }
    @Test fun activityThinkingCopyPreservesDuplicatesAndOrder() {
        val thinking = "  重复的原始思考  "
        val items = listOf(message("问题", "user"), message("", thinking = thinking).copy(id = "t1"),
            message("", thinking = thinking).copy(id = "t2"), message("回复").copy(id = "answer"))
        fixture { NativeActivityCard(LiveActivity("turn", "本轮", "done", items), {}) }
        pickActivityCopy("复制思考")
        compose.runOnIdle { assertEquals("$thinking\n\n$thinking", copied()) }
    }
    @Test fun toolArgumentsCopyIsNotLimitedByDisplayTruncation() {
        val args = """{"body":"${"x".repeat(66000)}TAIL"}"""
        fixture { NativeStepCard(tool(args), {}, {}, showArguments = true) }
        openTool()
        compose.onNodeWithText("复制参数").assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(args, copied()) }
    }
    @Test fun compactToolCanCopyArgumentsEvenWithoutAnOutputBody() {
        val args = """{"command":"npm test"}"""
        fixture { NativeStepCard(tool(args, "已完成"), {}, {}) }
        openTool()
        compose.onNodeWithText("复制输出").assertDoesNotExist()
        compose.onNodeWithText("复制参数").performClick()
        compose.runOnIdle { assertEquals(args, copied()) }
    }
    @Test fun toolOutputCopyPreservesWhitespace() {
        val output = "  原始输出\n\t第二行  "
        fixture { NativeStepCard(tool(output = output), {}, {}, showArguments = true) }
        openTool()
        compose.onNodeWithText("复制输出").performClick()
        compose.runOnIdle { assertEquals(output, copied()) }
    }
    @Test fun mergedToolThinkingCopiesChronologicalOriginals() {
        val a = message("", thinking = "  第一段  ")
        val b = message("", thinking = "第二段\n下一行").copy(id = "second")
        fixture { NativeStepCard(tool(), {}, {}, showArguments = true, precedingThinking = listOf(a, b)) }
        openTool()
        compose.onNodeWithText("复制思考").performClick()
        compose.runOnIdle { assertEquals("${a.thinking}\n\n${b.thinking}", copied()) }
    }
    @Test fun codeCopyKeepsCodeWithoutFenceOrLanguage() {
        val code = "  echo hello\n    printf world"
        fixture { MarkdownBody("```sh\n$code\n```") }
        compose.onNodeWithText("复制").assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(code, copied()) }
    }
    @Test fun markdownLongPressOffersPartialCopy() {
        val text = "alpha beta gamma"
        fixture { MarkdownBody(text) }
        compose.onNodeWithText(text).performTouchInput { longClick(center) }
        compose.runOnIdle {
            assertNotNull(toolbar.copy)
            toolbar.copy!!.invoke()
            assertTrue(!copied().isNullOrBlank())
            assertTrue(text.contains(copied()!!))
            assertNotEquals(text, copied())
        }
    }
    @Test fun longPressLinkSelectsWithoutOpeningIt() {
        var opens = 0
        fixture { MarkdownBody("[documentation](https://example.com)", onOpenUrl = { opens++ }) }
        compose.onNodeWithText("documentation").performTouchInput { longClick(center) }
        compose.runOnIdle {
            assertEquals(0, opens)
            assertNotNull(toolbar.copy)
            toolbar.copy!!.invoke()
            assertEquals("documentation", copied())
        }
    }
    @Test fun shortTapLinksStillOpensCorrectTarget() {
        var opened: String? = null
        fixture { MarkdownBody("[documentation](https://example.com)", onOpenUrl = { opened = it }) }
        compose.onNodeWithText("documentation").performTouchInput { click(center) }
        compose.runOnIdle { assertEquals("https://example.com", opened) }
    }
    @Test fun shortTapLocalPathStillOpensCorrectTarget() {
        var opened: String? = null
        fixture { MarkdownBody("/workspace/demo.txt", onOpenPath = { opened = it }) }
        compose.onNodeWithText("/workspace/demo.txt").performTouchInput { click(center) }
        compose.runOnIdle { assertEquals("/workspace/demo.txt", opened) }
    }
    @Test fun standaloneThinkingHasCopyAfterExpansion() {
        val thought = "独立思考\n完整第二行"
        fixture { NativeMessageCard(message("", thinking = thought), {}, {}, compactAssistant = true, enabled = false) }
        compose.onNodeWithText("复制思考").assertDoesNotExist()
        compose.onNodeWithText("独立思考").performClick()
        compose.onNodeWithText("复制思考").performClick()
        compose.runOnIdle { assertEquals(thought, copied()) }
    }
    @Test fun renderingDoesNotChangeExistingClipboard() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        clipboard(context).setPrimaryClip(ClipData.newPlainText("test", "sentinel"))
        fixture { NativeMessageCard(message("正文"), {}, {}, compactAssistant = true) }
        compose.runOnIdle { assertEquals("sentinel", clipboard(context).primaryClip!!.getItemAt(0).text.toString()) }
    }
    @Test fun emptyOrUnavailableClipboardDoesNotEraseExistingText() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        clipboard(context).setPrimaryClip(ClipData.newPlainText("test", "sentinel"))
        assertFalse(copyPlainText(context, ""))
        val unavailable = object : ContextWrapper(context) {
            override fun getSystemService(name: String): Any? = if (name == Context.CLIPBOARD_SERVICE) null else super.getSystemService(name)
        }
        assertFalse(copyPlainText(unavailable, "not-copied"))
        assertEquals("sentinel", clipboard(context).primaryClip!!.getItemAt(0).text.toString())
    }
    @Test fun commonActionHasTouchTargetAndFeedback() {
        fixture { CopyTextAction("完整原文") }
        compose.onNodeWithText("复制").assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals("完整原文", copied()); assertEquals("已复制", ShadowToast.getTextOfLatestToast()) }
    }
    @Test fun plainUserLongPressOffersSelection() {
        val text = "alpha beta gamma"
        fixture { NativeMessageCard(message(text, "user"), {}, {}, compactUser = true) }
        compose.onNodeWithText(text).performTouchInput { longClick(center) }
        compose.runOnIdle { assertNotNull(toolbar.copy) }
    }
    @Test fun clickableActivityPromptStillAllowsLongPressSelection() {
        val text = "alpha beta gamma"
        fixture { NativeActivityCard(activity("reply", text), {}) }
        // The clickable header merges its title and prompt; hit the actual text, not the header's centre.
        compose.onNodeWithText(text, useUnmergedTree = true).performTouchInput { longClick(center) }
        compose.runOnIdle { assertNotNull(toolbar.copy) }
    }
    private fun screenshotFixture(scale: Float = 1f, dark: Boolean = false) {
        fixture(scale, dark) {
            NativeMessageCard(message("可以复制这条消息。", "user"), {}, {}, compactUser = true, enabled = false)
            Spacer(Modifier.height(12.dp))
            NativeMessageCard(message("**已完成**：正文可长按选词，也可在右侧菜单复制。"), {}, {}, compactAssistant = true, enabled = false)
            Spacer(Modifier.height(12.dp))
            NativeStepCard(tool(), {}, {}, showArguments = true, precedingThinking = listOf(message("", thinking = "先核对文件内容。")))
        }
        openTool()
    }
    @Test fun copyActionsPreview() {
        screenshotFixture()
        compose.onRoot().captureRoboImage("src/test/screenshots/copy-actions.png")
    }
    @Test fun copyActionsDarkPreview() {
        screenshotFixture(dark = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/copy-actions-dark.png")
    }
    @Test fun copyActionsLargeFontPreview() {
        screenshotFixture(scale = 2f)
        compose.onRoot().captureRoboImage("src/test/screenshots/copy-actions-large-font.png")
    }
    @Test fun readOnlyMessageMenuOffersCopyWithoutOwnership() {
        fixture { NativeMessageCard(message("只读会话也可以复制正文。", thinking = "完整思考"), {}, {}, compactAssistant = true, enabled = false) }
        compose.onNodeWithContentDescription("回复操作").performClick()
        compose.onNodeWithText("复制正文").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("复制思考").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("查看思考").assertIsDisplayed()
    }

    private class SelectionToolbar : TextToolbar {
        override var status = TextToolbarStatus.Hidden
        var copy: (() -> Unit)? = null
        override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?,
            onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
            copy = onCopyRequested; status = TextToolbarStatus.Shown
        }
        override fun hide() { status = TextToolbarStatus.Hidden }
    }
}

/** Robolectric has no Surface for the native magnifier popup. Selection gestures still run unchanged. */
@Implements(Magnifier::class)
class CopySelectionMagnifier {
    @Implementation fun show(x: Float, y: Float) {}
    @Implementation fun show(x: Float, y: Float, magnifierX: Float, magnifierY: Float) {}
    @Implementation fun update() {}
    @Implementation fun dismiss() {}
}
