package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sam.pidash.domain.model.LiveUiRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun SudoApprovalDialog(request: LiveUiRequest, onAnswer: suspend (String?, Boolean) -> Result<Unit>) {
    // Deliberately not rememberSaveable, ViewModel state, transcript state, or a preference.
    var password by remember(request.id) { mutableStateOf("") }
    var busy by remember(request.id) { mutableStateOf(false) }
    var error by remember(request.id) { mutableStateOf<String?>(null) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, request.id) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) password = "" }
        lifecycle.addObserver(observer)
        onDispose { password = ""; lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(request.id) { while (true) { now = System.currentTimeMillis(); if (now >= (request.expiresAt ?: 0)) password = ""; delay(500) } }
    val valid = !request.command.isNullOrBlank() && !request.cwd.isNullOrBlank() && !request.host.isNullOrBlank() && (request.expiresAt ?: 0) > now
    fun respond(cancelled: Boolean) {
        if (busy || (!cancelled && !valid)) return
        val secret = if (cancelled) null else password
        password = ""; busy = true; error = null
        scope.launch {
            onAnswer(secret, cancelled).onFailure { error = "授权未确认送达或请求已失效，请检查会话状态。不会自动重试。" }
            busy = false
        }
    }
    AlertDialog(
        onDismissRequest = {},
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false, securePolicy = SecureFlagPolicy.SecureOn),
        title = { Text("管理员授权 · 仅本次命令") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("此操作将以 root 执行。请核对目标及每个参数；批准执行脚本也意味着信任脚本当前内容。", style = MaterialTheme.typography.bodySmall)
                Text("机器：${request.host.orEmpty()}")
                Text("目录：${request.cwd.orEmpty()}")
                SelectionContainer { Text(request.command.orEmpty(), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)) }
                Text("上方为可执行文件与参数数组，不进行 Shell 展开。密码不保存、不加入聊天；仅支持 HTTPS 连接。", style = MaterialTheme.typography.bodySmall)
                if (!valid) Text("授权请求已过期或信息不完整，请取消。", color = MaterialTheme.colorScheme.error)
                OutlinedTextField(
                    value = password, onValueChange = { if (it.length <= 4096 && it.none { c -> c == '\n' || c == '\r' || c == '\u0000' }) password = it },
                    modifier = Modifier.fillMaxWidth(), label = { Text("目标机器的 sudo 密码") },
                    enabled = !busy && valid, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                )
                Text("无需密码的规则可留空。取消、过期不会执行；执行开始后取消不保证撤销已完成的改动。", style = MaterialTheme.typography.bodySmall)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = { TextButton(enabled = !busy && valid, onClick = { respond(false) }) { Text("授权并执行一次") } },
        dismissButton = { TextButton(enabled = !busy, onClick = { respond(true) }) { Text("取消") } },
    )
}
