package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.launch
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii

/** Destructive action is explicit and never retried automatically. */
@Composable
fun LiveShutdownDialog(
    repo: PiDashRepository,
    sessionKey: SessionKey,
    title: String,
    onDismiss: () -> Unit,
    onAccepted: () -> Unit,
) {
    var busy by remember(sessionKey) { mutableStateOf(false) }
    var error by remember(sessionKey) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(shape = Radii.sheet,
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("关闭 Pi 会话？", style = PiType.pageTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("将退出「$title」的 Pi 进程，中断正在执行的任务。已保存的会话记录不会删除。")
                Text("不会自动重试。若请求超时，请先刷新列表确认进程状态，避免重复操作。", style = PiType.subhead)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                busy = true; error = null
                scope.launch {
                    repo.live.shutdown(sessionKey).fold(
                        onSuccess = { onAccepted() },
                        onFailure = { error = it.message ?: "关闭请求失败，请刷新确认状态" },
                    )
                    busy = false
                }
            }) { Text(if (busy) "正在请求…" else "确认关闭会话", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") } },
    )
}
