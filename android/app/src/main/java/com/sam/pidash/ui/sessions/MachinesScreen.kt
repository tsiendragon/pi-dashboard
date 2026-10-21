package com.sam.pidash.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.ui.common.AppVersionLabel
import com.sam.pidash.ui.common.backendOriginLabel
import com.sam.pidash.ui.common.liveConnectionLabel
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(repo: PiDashRepository, onOpen: (String) -> Unit, onSettings: () -> Unit) {
    val backends by repo.backends.collectAsState()
    val sessions by repo.live.sessions.collectAsState()
    val states by repo.live.backendStates.collectAsState()
    val chat by repo.connection.collectAsState()
    val scope = rememberCoroutineScope()
    Scaffold(topBar = {
        TopAppBar(title = { Column { Text("机器 / Dashboard"); AppVersionLabel() } }, actions = {
            IconButton(onClick = { scope.launch { repo.live.refreshAll() } }) { Icon(Icons.Default.Refresh, "刷新机器状态") }
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, "管理机器") }
        })
    }, floatingActionButton = {
        FloatingActionButton(onClick = onSettings) { Icon(Icons.Default.Add, "添加机器") }
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(12.dp, 8.dp, 12.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("先选择机器，再查看它自己的分组、会话与进度。不会扫描内网或接管会话。", style = MaterialTheme.typography.bodySmall) }
            if (backends.isEmpty()) item { Text("尚未配置 Dashboard，请点 + 添加现有服务器地址。") }
            items(backends, key = { it.id }) { backend ->
                val state = states[backend.id]
                val main = sessions.filter { it.key.backendId == backend.id && it.summary.role != "subagent" && it.summary.parentSessionId == null }
                OutlinedCard(Modifier.fillMaxWidth().clickable { onOpen(backend.id) }) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(backend.name, style = MaterialTheme.typography.titleMedium)
                        Text(backendOriginLabel(backend.baseUrl), style = MaterialTheme.typography.labelSmall)
                        Text(liveConnectionLabel(state))
                        Text(if (state?.connected == true) "${main.size} 个在线主会话 · ${main.count { it.summary.status == "running" }} 个工作中"
                            else "尚未取得已授权 Live 列表，不等于没有会话", style = MaterialTheme.typography.bodySmall)
                        Text("普通 Chat：" + when (chat[backend.id]) {
                            ConnectionState.Connected -> "已连接（不代表 Live 已配对）"
                            ConnectionState.Connecting -> "连接中"
                            else -> "未连接"
                        }, style = MaterialTheme.typography.labelSmall)
                        if (state?.needsPairing == true) Text("进入此 Dashboard → 配对；使用网页的一次性手机配对码。", style = MaterialTheme.typography.bodySmall)
                        else state?.message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                        Text("打开 Dashboard →", color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
    }
}
