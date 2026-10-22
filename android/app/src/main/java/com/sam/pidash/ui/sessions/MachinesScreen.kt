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
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.Alignment
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.MetaLine
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
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
    Scaffold(containerColor = MaterialTheme.colorScheme.surfaceVariant, topBar = {
        TopAppBar(title = { Column { Text("机器 / Dashboard"); AppVersionLabel() } }, actions = {
            IconButton(onClick = { scope.launch { repo.live.refreshAll() } }) { Icon(Icons.Default.Refresh, "刷新机器状态") }
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, "管理机器") }
        })
    }, floatingActionButton = {
        FloatingActionButton(onClick = onSettings) { Icon(Icons.Default.Add, "添加机器") }
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(horizontal = Spacing.lg, vertical = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            item { MetaText("先选择机器，再查看它自己的分组、会话与进度。", maxLines = 2) }
            if (backends.isEmpty()) item { MetaText("尚未配置 Dashboard，请点 + 添加现有服务器地址。", maxLines = 2) }
            items(backends, key = { it.id }) { backend ->
                val state = states[backend.id]
                val main = sessions.filter { it.key.backendId == backend.id && it.summary.role != "subagent" && it.summary.parentSessionId == null }
                val running = main.count { it.summary.status == "running" }
                val live = state?.connected == true
                GroupedCard(Modifier.clickable { onOpen(backend.id) }) {
                Column(
                    Modifier.fillMaxWidth().padding(Spacing.lg),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(backend.name, style = PiType.title, modifier = Modifier.weight(1f), maxLines = 1)
                        if (running > 0) StatusDot(MaterialTheme.colorScheme.primary)
                    }
                    Text(
                        backendOriginLabel(backend.baseUrl),
                        style = PiType.monoMicro,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.85f),
                        maxLines = 1,
                    )
                    MetaLine(
                        listOfNotNull(
                            if (live) "Live 已连接" else "Live 未连接",
                            "${main.size} 个主会话",
                            running.takeIf { it > 0 }?.let { "$it 工作中" },
                            "Chat " + when (chat[backend.id]) {
                                ConnectionState.Connected -> "已连接"
                                ConnectionState.Connecting -> "连接中"
                                else -> "未连接"
                            },
                            state?.needsPairing?.takeIf { it }?.let { "需要配对" },
                        )
                    )
                    when {
                        state?.needsPairing == true -> MetaText(
                            "进入此 Dashboard 后用网页的一次性配对码配对。",
                            maxLines = 2,
                        )
                        state?.message != null -> MetaText(state.message!!, tint = MaterialTheme.colorScheme.error, maxLines = 2)
                        !live -> MetaText("尚未取得已授权 Live 列表，不等于没有会话。", maxLines = 2)
                    }
                }
                }
            }
        }
    }
}
