package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.data.remote.ExecClient
import com.sam.pidash.data.remote.InteractiveCommand
import com.sam.pidash.domain.model.terminalDisplay
import com.sam.pidash.ui.common.CopyTextAction
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints
import kotlinx.coroutines.launch

private const val EXEC_OUTPUT_LIMIT = 200_000

/** Explicit, because "stopped" and "exited with a code" must not look alike. */
private sealed interface ExecPhase {
    data object Idle : ExecPhase
    data object Running : ExecPhase
    data class Done(val code: Int) : ExecPhase
    data object Stopped : ExecPhase
    data class Failed(val message: String) : ExecPhase
}

/**
 * Run one command on the server with a real TTY, from the phone.
 *
 * Meant for the case the agent cannot handle itself: a script that reads a password with
 * `getpass`, an SSH prompt, a REPL. It is deliberately a command runner rather than a
 * terminal — the user confirms one command, types into it, and the process dies with the
 * page. Nothing here is written to the session, to disk, or to the decision log.
 */
@Composable
internal fun ExecConsole(
    initialCommand: String,
    cwd: String,
    openCommand: () -> InteractiveCommand,
    onDismiss: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    var command by remember(initialCommand) { mutableStateOf(initialCommand) }
    var phase by remember { mutableStateOf<ExecPhase>(ExecPhase.Idle) }
    var output by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    var hidden by remember { mutableStateOf(false) }
    var client by remember { mutableStateOf<InteractiveCommand?>(null) }
    val outputScroll = rememberScrollState()
    val clipboard = LocalClipboardManager.current
    val running = phase is ExecPhase.Running

    fun stop(markStopped: Boolean) {
        client?.close()
        client = null
        if (markStopped) phase = ExecPhase.Stopped
    }

    fun run() {
        val text = command.trim()
        if (text.isEmpty() || running) return
        output = ""
        phase = ExecPhase.Running
        val next = openCommand()
        client = next
        next.start(text, cwd)
        scope.launch {
            next.events.collect { event ->
                when (event) {
                    ExecClient.Event.Started -> Unit
                    is ExecClient.Event.Output -> {
                        val merged = output + event.text
                        output = if (merged.length > EXEC_OUTPUT_LIMIT) merged.takeLast(EXEC_OUTPUT_LIMIT) else merged
                    }
                    is ExecClient.Event.Exited -> phase = ExecPhase.Done(event.code)
                    is ExecClient.Event.Failed -> phase = ExecPhase.Failed(event.message)
                }
            }
        }
    }

    // Leaving the page (or the dialog) must not leave a command running on the server.
    DisposableEffect(Unit) { onDispose { client?.close() } }
    LaunchedEffect(output) {
        if (output.isNotEmpty()) outputScroll.animateScrollTo(outputScroll.maxValue)
    }

    Dialog(onDismissRequest = { stop(markStopped = false); onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        androidx.compose.material3.Surface(Modifier.fillMaxSize(), color = scheme.background) {
            Column(Modifier.fillMaxSize().padding(horizontal = Spacing.md, vertical = Spacing.sm)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("在服务器运行", style = PiType.pageTitle)
                        Text(cwd, style = PiType.caption, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (running) TextButton(onClick = { stop(markStopped = true) }) { Text("结束命令") }
                    TextButton(onClick = { stop(markStopped = false); onDismiss() }) { Text("关闭") }
                }
                Text(
                    "以 Dashboard 用户身份执行；输入直接送给这条命令，不写入会话、磁盘或审批记录。关闭本页会结束进程。",
                    style = PiType.caption,
                    color = scheme.onSurfaceVariant,
                )
                HorizontalDivider(Modifier.padding(vertical = Spacing.sm), color = scheme.outline.copy(alpha = Tints.Hairline))

                if (phase is ExecPhase.Idle) {
                    Text("命令", style = PiType.action.copy(fontWeight = FontWeight.SemiBold))
                    PiTextField(
                        value = command,
                        onValueChange = { command = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = "例如 python3 set-verify-credentials.py",
                        singleLine = false,
                        minLines = 3,
                        maxLines = 8,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                        Button(onClick = { run() }, enabled = command.isNotBlank(), shape = Radii.card) { Text("运行") }
                        TextButton(onClick = {
                            // A deliberate tap, never on open: reading the clipboard is the user's action.
                            val clip = runCatching { clipboard.getText()?.text }.getOrNull().orEmpty().trim()
                            if (clip.isNotBlank()) command = clip
                        }) { Text("粘贴剪贴板") }
                        CopyTextAction(command)
                    }
                    Text(
                        "需要密码时把「隐藏输入」打开：字段不再回显，脚本自身也不会回显密码。",
                        style = PiType.caption,
                        color = scheme.onSurfaceVariant,
                    )
                    Row(Modifier.fillMaxWidth().padding(top = Spacing.sm), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { stop(markStopped = false); onDismiss() }) { Text("取消") }
                    }
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        if (running) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        Text(
                            when (val current = phase) {
                                ExecPhase.Running -> "运行中"
                                is ExecPhase.Done -> "已结束（退出码 ${current.code}）"
                                ExecPhase.Stopped -> "已中断"
                                is ExecPhase.Failed -> "已中断"
                                ExecPhase.Idle -> ""
                            },
                            style = PiType.caption.copy(fontWeight = FontWeight.SemiBold),
                            color = when (phase) {
                                is ExecPhase.Failed -> scheme.error
                                ExecPhase.Running -> scheme.primary
                                else -> scheme.onSurfaceVariant
                            },
                        )
                        Text(
                            command.lineSequence().firstOrNull().orEmpty(),
                            modifier = Modifier.weight(1f),
                            style = PiType.caption.copy(fontFamily = FontFamily.Monospace),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    (phase as? ExecPhase.Failed)?.let { Text(it.message, style = PiType.caption, color = scheme.error) }
                    Box(
                        Modifier.weight(1f).fillMaxWidth()
                            .background(scheme.surfaceVariant.copy(alpha = Tints.Block), Radii.card)
                            .verticalScroll(outputScroll)
                            .padding(Spacing.sm),
                    ) {
                        SelectionContainer {
                            Text(
                                terminalDisplay(output).ifBlank { if (running) "（等待输出…）" else "（没有输出）" },
                                style = PiType.mono,
                            )
                        }
                    }
                    if (running) {
                        Row(
                            Modifier.fillMaxWidth().padding(top = Spacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                        ) {
                            PiTextField(
                                value = input,
                                onValueChange = { input = it },
                                modifier = Modifier.weight(1f),
                                placeholder = if (hidden) "输入（不回显）" else "输入并回车",
                                singleLine = true,
                                isPassword = hidden,
                            )
                            TextButton(
                                onClick = {
                                    client?.send(input + "\n")
                                    input = ""
                                },
                                enabled = input.isNotEmpty(),
                                modifier = Modifier.heightIn(min = 48.dp),
                            ) { Text("发送") }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { hidden = !hidden }, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text(if (hidden) "隐藏输入：开" else "隐藏输入：关")
                            }
                            TextButton(onClick = { client?.interrupt() }, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text("Ctrl-C")
                            }
                        }
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.padding(top = Spacing.sm)) {
                            Button(
                                onClick = {
                                    phase = ExecPhase.Idle
                                    output = ""
                                },
                                shape = Radii.card,
                            ) { Text("再次运行") }
                            TextButton(onClick = { stop(markStopped = false); onDismiss() }) { Text("关闭") }
                        }
                    }
                }
            }
        }
    }
}