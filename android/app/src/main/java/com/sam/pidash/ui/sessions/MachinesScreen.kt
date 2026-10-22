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
import com.sam.pidash.ui.common.InfoPill
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
                val running = main.count { it.summary.status == "running" }
                val live = state?.connected == true
                OutlinedCard(
                    modifier = Modifier.fillMaxWidth().clickable { onOpen(backend.id) },
                    shape = Radii.card,
                    colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surface),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)),
                ) {
                    Column(
                        Modifier.padding(Spacing.lg),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(backend.name, style = PiType.title, modifier = Modifier.weight(1f), maxLines = 1)
                            StatusDot(
                                if (running > 0) MaterialTheme.colorScheme.primary
                                else if (live) MaterialTheme.colorScheme.secondary
                                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                                size = 8.dp,
                            )
                        }
                        Text(
                            backendOriginLabel(backend.baseUrl),
                            style = PiType.monoMicro,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                        Row(
                            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                        ) {
                            InfoPill(
                                if (live) "Live 已连接" else "Live 未连接",
                                tint = if (live) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            InfoPill("${main.size} 个主会话")
                            if (running > 0) InfoPill("$running 工作中", tint = MaterialTheme.colorScheme.primary)
                            if (state?.needsPairing == true) InfoPill("需要配对", tint = MaterialTheme.colorScheme.error)
                            InfoPill(
                                "Chat " + when (chat[backend.id]) {
                                    ConnectionState.Connected -> "已连接"
                                    ConnectionState.Connecting -> "连接中"
                                    else -> "未连接"
                                },
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        when {
                            state?.needsPairing == true -> Text(
                                "进入此 Dashboard 后用网页的一次性配对码配对。",
                                style = PiType.meta,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            state?.message != null -> Text(
                                state.message!!,
                                style = PiType.meta,
                                color = MaterialTheme.colorScheme.error,
                            )
                            !live -> Text(
                                "尚未取得已授权 Live 列表，不等于没有会话。",
                                style = PiType.meta,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Spacer(Modifier.weight(1f))
                            Text("打开 Dashboard", style = PiType.micro, color = MaterialTheme.colorScheme.primary)
                            Text(" →", style = PiType.micro, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }
}
