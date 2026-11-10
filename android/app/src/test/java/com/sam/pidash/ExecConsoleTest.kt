package com.sam.pidash

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.data.remote.ExecClient
import com.sam.pidash.data.remote.InteractiveCommand
import com.sam.pidash.ui.live.ExecConsole
import com.sam.pidash.ui.theme.PiDashTheme
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Fake PTY channel: records what the console sent and lets the test emit output. */
private class FakeCommand : InteractiveCommand {
    override val events = MutableSharedFlow<ExecClient.Event>(extraBufferCapacity = 64)
    val starts = mutableListOf<Pair<String, String>>()
    val inputs = mutableListOf<String>()
    var interrupts = 0
    var closes = 0
    override fun start(command: String, cwd: String, cols: Int, rows: Int) { starts += command to cwd }
    override fun send(text: String) { inputs += text }
    override fun interrupt() { interrupts++ }
    override fun close() { closes++ }
    fun emitOutput(text: String) { events.tryEmit(ExecClient.Event.Output(text)) }
    fun emitExit(code: Int) { events.tryEmit(ExecClient.Event.Exited(code)) }
    fun emitFailure(message: String) { events.tryEmit(ExecClient.Event.Failed("x", message)) }
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class ExecConsoleTest {
    @get:Rule val compose = createComposeRule()
    private val fake = FakeCommand()
    private var dismissed = 0

    private fun fixture(command: String = "python3 set-verify-credentials.py") {
        compose.setContent {
            PiDashTheme {
                ExecConsole(
                    initialCommand = command,
                    cwd = "/home/tsien/apps/demo",
                    openCommand = { fake },
                    onDismiss = { dismissed++ },
                )
            }
        }
    }

    @Test fun showsTheConfirmedCommandAndWorkingDirectoryBeforeRunning() {
        fixture()
        compose.onNodeWithText("在服务器运行").assertIsDisplayed()
        compose.onNodeWithText("/home/tsien/apps/demo").assertIsDisplayed()
        compose.onNodeWithText("python3 set-verify-credentials.py").assertIsDisplayed()
        compose.onNodeWithText("运行").assertIsDisplayed()
        assertTrue("must not start before the user taps 运行", fake.starts.isEmpty())
    }

    @Test fun runsExactlyTheConfirmedCommandInTheSessionDirectory() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        assertEquals(listOf("python3 set-verify-credentials.py" to "/home/tsien/apps/demo"), fake.starts)
    }

    @Test fun streamsOutputAndReportsTheExitCode() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        compose.runOnIdle { fake.emitOutput("\u001B[32mhello\u001B[0m\n") }
        compose.onNodeWithText("hello", substring = true).assertIsDisplayed()
        compose.onNodeWithText("运行中").assertIsDisplayed()
        compose.runOnIdle { fake.emitExit(2) }
        compose.onNodeWithText("已结束（退出码 2）").assertIsDisplayed()
    }

    @Test fun typedInputIsSentVerbatimAndClearedFromTheField() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        compose.onNodeWithText("输入并回车").performTextInput("hello")
        compose.onNodeWithText("发送").performClick()
        assertEquals(listOf("hello\n"), fake.inputs)
        compose.onNodeWithText("输入并回车").assertIsDisplayed()
    }

    @Test fun hiddenInputMasksTheFieldButStillSendsTheSameBytes() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        compose.onNodeWithText("隐藏输入：关").performClick()
        compose.onNodeWithText("隐藏输入：开").assertIsDisplayed()
        compose.onNodeWithText("输入（不回显）").performTextInput("super-secret")
        compose.onNodeWithText("发送").performClick()
        assertEquals(listOf("super-secret\n"), fake.inputs)
        // The secret is never rendered back into the console.
        compose.onNodeWithText("super-secret").assertDoesNotExist()
    }

    @Test fun ctrlCAndStopBothReachTheProcess() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        compose.onNodeWithText("Ctrl-C").performClick()
        assertEquals(1, fake.interrupts)
        compose.onNodeWithText("结束命令").performClick()
        assertEquals(1, fake.closes)
        compose.onNodeWithText("已中断").assertIsDisplayed()
    }

    @Test fun aServerFailureIsShownAndStopsTheRun() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        compose.runOnIdle { fake.emitFailure("目录不存在或不可访问") }
        compose.onNodeWithText("目录不存在或不可访问").assertIsDisplayed()
        compose.onNodeWithText("运行中").assertDoesNotExist()
    }

    @Test fun closingAlwaysStopsTheServerProcess() {
        fixture()
        compose.onNodeWithText("运行").performClick()
        compose.onNodeWithText("关闭").performClick()
        assertEquals(1, fake.closes)
        assertEquals(1, dismissed)
    }

    @Test fun anEmptyCommandCannotBeRun() {
        fixture(command = "")
        compose.onNodeWithText("运行").assertIsNotEnabled()
    }
}