package com.sam.pidash

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.ActivityDetailRow
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.TranscriptRow
import com.sam.pidash.domain.model.groupActivityDetail
import com.sam.pidash.ui.live.DetailTraceBlock
import com.sam.pidash.ui.live.NativeTimelineRow
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The "完整" transcript: prose plus one folded trace block per run, not alternating cards. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h720dp-xhdpi")
class LiveCompleteTranscriptTest {
    @get:Rule val compose = createComposeRule()

    private fun thought(id: String, text: String) = LiveTimelineItem(id, "assistant", "", thinking = text)
    private fun tool(id: String, name: String, command: String, error: Boolean = false) = LiveTimelineItem(
        id, "tool",
        if (error) "The symlink check fails because canonical() resolves the parent." else "ok",
        toolName = name, toolCallId = id, toolArgs = """{"command":"$command"}""",
        status = if (error) "error" else "done", isError = error,
    )
    private fun prose(id: String, text: String) = LiveTimelineItem(id, "assistant", text)

    private fun items() = listOf(
        thought("t1", "Now I can implement:"),
        tool("c1", "read", "/home/tsien/repos/pi-matrix/src/pi.ts"),
        tool("c2", "read", "/home/tsien/repos/pi-matrix/package.json"),
        thought("t2", "That's for CLI-owned paths. For the report file, I'll import the helper."),
        tool("c3", "bash", "python3 - <<'PY' import pathlib … PY"),
        tool("c4", "bash", "npm run typecheck"),
        thought("t3", "The TS side: partial hint in the prompt, and escalation."),
        prose("a1", "Now the TS side — partial hint in the prompt, and escalation:"),
        tool("c5", "bash", "cd /home/tsien/repos/pi-matrix && python3 - <<'PY' import package PY"),
        thought("t4", "TS compiles. Now #5: report file on the Pi tool path."),
        tool("c6", "bash", "npm test", error = true),
        tool("c7", "bash", "node scripts/check.mjs"),
        thought("t5", "39 checks. Now Python test for `hint`:"),
    )

    private fun fixture(dark: Boolean = false, expandAll: Boolean = false) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1f)) {
                PiDashTheme(darkTheme = dark) {
                    val rows = remember { groupActivityDetail(items()) }
                    Column(
                        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
                            .verticalScroll(rememberScrollState()).padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        rows.forEach { row ->
                            when (row) {
                                is ActivityDetailRow.Trace -> {
                                    var expanded by remember(row.id) {
                                        mutableStateOf(if (expandAll) true else row.items.size <= 4)
                                    }
                                    DetailTraceBlock(
                                        row = row,
                                        expanded = expanded,
                                        onToggle = { expanded = !expanded },
                                        onOpenPath = {},
                                        onOpenUrl = {},
                                        showArguments = false,
                                    )
                                }
                                is ActivityDetailRow.Message -> NativeTimelineRow(
                                    row = TranscriptRow.Single(row.item), onOpenPath = {}, onOpenUrl = {},
                                    onFork = {}, enabled = true, onQuote = {}, onAnnotate = {},
                                    compactUser = true, compactAssistant = true,
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    @Test fun foldedLight() {
        fixture()
        compose.onAllNodesWithText("执行记录")[0].assertExists()
        compose.onAllNodesWithText("执行记录")[1].assertExists()
        compose.onNodeWithText("Now the TS side", substring = true).assertExists()
        // A folded block must say what ran, not only how many steps there were.
        compose.onNodeWithText("read · /home/tsien/repos/pi-matrix/src/pi.ts", substring = true).assertExists()
        // The failing step leads its block, so a failure is visible while folded.
        compose.onNodeWithText("bash · npm test", substring = true).assertExists()
        compose.onRoot().captureRoboImage("src/test/screenshots/full-transcript.png")
    }

    @Test fun expandedFirstBlock() {
        fixture(expandAll = true)
        // The rows themselves show the commands, so the folded digest disappears.
        compose.onNodeWithText("read · /home/tsien/repos/pi-matrix/src/pi.ts", substring = true).assertDoesNotExist()
        compose.onRoot().captureRoboImage("src/test/screenshots/full-transcript-expanded.png")
    }

    @Test fun foldedDark() {
        fixture(dark = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/full-transcript-dark.png")
    }
}
