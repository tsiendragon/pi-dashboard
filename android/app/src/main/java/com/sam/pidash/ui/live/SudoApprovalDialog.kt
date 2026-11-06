package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun SudoApprovalDialog(request: LiveUiRequest, onAnswer: suspend (String?, Boolean) -> Result<Unit>) {
    // Deliberately not rememberSaveable, ViewModel state, transcript state, or a preference.
    var password by remember(request.id) { mutableStateOf("") }
    var busy by remember(request.id) { mutableStateOf(false) }
    var error by remember(request.id) { mutableStateOf<String?>(null) }
    var now by remember(request.id) { mutableStateOf(System.currentTimeMillis()) }
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, request.id) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) password = "" }
        lifecycle.addObserver(observer)
        onDispose { password = ""; lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(request.id) {
        while (true) { now = System.currentTimeMillis(); if (now >= (request.expiresAt ?: 0)) password = ""; delay(500) }
    }
    val valid = sudoReviewReady(request, now)
    fun respond(cancelled: Boolean) {
        if (busy || (!cancelled && !valid)) return
        val secret = if (cancelled) null else password
        password = ""; busy = true; error = null
        scope.launch {
            onAnswer(secret, cancelled).onFailure { error = "授权未确认送达或请求已失效。请检查会话状态，不会自动重试。" }
            busy = false
        }
    }
    Dialog(
        onDismissRequest = {},
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false,
            securePolicy = SecureFlagPolicy.SecureOn, usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        SudoApprovalContent(request, password, { password = it }, busy, error, now, ::respond)
    }
}

internal fun sudoReviewReady(request: LiveUiRequest, now: Long): Boolean =
    sudoCommandReview(request.command) != null && !request.cwd.isNullOrBlank() && !request.host.isNullOrBlank() &&
        !request.message.isNullOrBlank() && request.message.length <= 800 && (request.expiresAt ?: 0) > now

/** Shared with synthetic layout fixtures; this does not grant permission or disable the secure window. */
@Composable
internal fun SudoApprovalContent(
    request: LiveUiRequest, password: String, onPasswordChange: (String) -> Unit,
    busy: Boolean, error: String?, now: Long, onRespond: (Boolean) -> Unit,
) {
    val command = remember(request.command) { sudoCommandReview(request.command) }
    val valid = sudoReviewReady(request, now)
    var rawExpanded by remember(request.id) { mutableStateOf(false) }
    var detailsExpanded by remember(request.id) { mutableStateOf(false) }
    val millisecondsLeft = ((request.expiresAt ?: 0) - now).coerceAtLeast(0)
    val remaining = millisecondsLeft / 1000 + if (millisecondsLeft % 1000 > 0) 1 else 0
    BoxWithConstraints(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(horizontal = Spacing.md, vertical = Spacing.lg),
        contentAlignment = Alignment.Center,
    ) {
        Surface(Modifier.widthIn(max = 560.dp).fillMaxWidth().heightIn(max = maxHeight),
            shape = Radii.sheet, color = MaterialTheme.colorScheme.surface) {
            Column {
                Row(Modifier.fillMaxWidth().padding(Spacing.lg), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                    Surface(shape = Radii.card, color = MaterialTheme.colorScheme.primaryContainer) {
                        Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.Lock, contentDescription = null, modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        Text("管理员授权", style = PiType.headline)
                        Text("以 root 运行 · 仅这一次", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(if (remaining > 0) "${remaining / 60}:${(remaining % 60).toString().padStart(2, '0')}" else "已过期",
                        style = PiType.caption, color = if (remaining > 0) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
                }
                HorizontalDivider(thickness = Hairline, color = MaterialTheme.colorScheme.outlineVariant)
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                    .padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        ReviewLabel("执行说明")
                        Text(sudoVisibleText(request.message?.takeIf { it.isNotBlank() } ?: "未提供用途说明。请取消，让 Pi 补充说明后重新申请。"),
                            style = PiType.body, color = if (request.message.isNullOrBlank()) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                        Text("由 Pi 提供说明，请以下方实际命令为准。", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        ReviewLabel("将执行的命令")
                        Surface(Modifier.fillMaxWidth(), shape = Radii.card, color = MaterialTheme.colorScheme.surfaceVariant) {
                            SelectionContainer {
                                Text(command?.preview ?: sudoVisibleText(request.command.orEmpty()),
                                    Modifier.padding(Spacing.md), style = PiType.mono, color = MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        Text("按参数直接执行，不额外进行 Shell 展开。", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (command != null) {
                            TextButton(onClick = { rawExpanded = !rawExpanded }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                                Text(if (rawExpanded) "收起原始参数" else "查看原始参数 · 精确核对")
                            }
                            if (rawExpanded) SelectionContainer { Text(command.rawArguments, style = PiType.monoMicro) }
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                        ReviewField("目标机器", request.host.orEmpty())
                        ReviewField("工作目录", request.cwd.orEmpty())
                    }
                    HorizontalDivider(thickness = Hairline, color = MaterialTheme.colorScheme.outlineVariant)
                    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        Text("root 权限可能修改系统。若调用脚本或解释器，也请核对其内容。", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(value = password, onValueChange = {
                            if (it.length <= 4096 && it.none { c -> c == '\n' || c == '\r' || c == '\u0000' }) onPasswordChange(it)
                        }, modifier = Modifier.fillMaxWidth(), label = { Text("sudo 密码") },
                            supportingText = { Text("密码不保存、不进入聊天。已有免密规则可留空。", style = PiType.caption) },
                            enabled = !busy && valid, singleLine = true, shape = Radii.card,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
                        TextButton(onClick = { detailsExpanded = !detailsExpanded }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                            Text(if (detailsExpanded) "收起权限说明" else "密码与权限说明")
                        }
                        if (detailsExpanded) Text("仅通过 HTTPS 提交。不会开启全局免密。取消或过期不执行；命令开始后无法保证撤销已完成的改动。命令预览只供阅读，控制字符会转义显示，准确参数以原始数组为准。",
                            style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!valid) Text(when {
                        (request.expiresAt ?: 0) <= now -> "请求已过期，请取消后重新申请。"
                        request.message.isNullOrBlank() -> "缺少执行说明，暂不能授权。请先更新扩展并重新申请。"
                        else -> "请求信息不完整或格式无效，暂不能授权。"
                    }, style = PiType.footnote, color = MaterialTheme.colorScheme.error)
                    error?.let { Text(it, style = PiType.footnote, color = MaterialTheme.colorScheme.error) }
                    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                HorizontalDivider(thickness = Hairline, color = MaterialTheme.colorScheme.outlineVariant)
                Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        OutlinedButton(onClick = { onRespond(true) }, enabled = !busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp), shape = Radii.card) { Text("取消") }
                        Button(onClick = { onRespond(false) }, enabled = !busy && valid,
                            modifier = Modifier.weight(1.6f).heightIn(min = 48.dp), shape = Radii.card) { Text(if (busy) "提交授权…" else "授权并执行") }
                    }
                    Text("请先核对命令和目标，再批准执行。", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun ReviewLabel(text: String) { Text(text, style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant) }

@Composable
private fun ReviewField(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        ReviewLabel(label)
        SelectionContainer { Text(sudoVisibleText(value), style = PiType.footnote) }
    }
}
