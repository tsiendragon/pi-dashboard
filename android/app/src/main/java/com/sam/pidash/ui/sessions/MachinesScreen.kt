package com.sam.pidash.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.ui.common.CompactHeaderAction
import com.sam.pidash.ui.common.CompactPageHeader
import com.sam.pidash.ui.common.PrimaryCreateAction
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.MetaLine
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.PulsingDot
import com.sam.pidash.ui.common.backendOriginLabel
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Tints
import com.sam.pidash.ui.theme.Spacing
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(repo: PiDashRepository, onOpen: (String) -> Unit, onSettings: () -> Unit) {
    val backends by repo.backends.collectAsState()
    val sessions by repo.live.sessions.collectAsState()
    val states by repo.live.backendStates.collectAsState()
    val chat by repo.connection.collectAsState()
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var restartTargetId by remember { mutableStateOf<String?>(null) }
    var restartingBackendId by remember { mutableStateOf<String?>(null) }
    var restartError by remember { mutableStateOf<String?>(null) }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, snackbarHost = { SnackbarHost(snackbarHostState) }, topBar = {
        CompactPageHeader(title = "机器 / Dashboard", actions = {
            CompactHeaderAction(Icons.Default.Refresh, "刷新机器状态") { scope.launch { repo.live.refreshAll() } }
            CompactHeaderAction(Icons.Default.Settings, "管理机器", onSettings)
        })
    }, floatingActionButton = {
        PrimaryCreateAction("添加机器", onClick = onSettings)
    }) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(start = Spacing.md, end = Spacing.md, top = Spacing.sm, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (backends.isEmpty()) item {
                MetaText("尚未配置 Dashboard，请点 + 添加现有服务器地址。", maxLines = 2)
            }
            items(backends, key = { it.id }) { backend ->
                val state = states[backend.id]
                val main = sessions.filter {
                    it.key.backendId == backend.id && it.summary.role != "subagent" && it.summary.parentSessionId == null
                }
                val running = main.count { it.summary.status == "running" }
                val live = state?.connected == true
                GroupedCard(Modifier.clickable { onOpen(backend.id) }) {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.md),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            Text(
                                backend.name,
                                style = PiType.rowTitle,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (running > 0) PulsingDot(MaterialTheme.colorScheme.primary, size = 5.dp, contentDescription = "运行中")
                        }
                        Text(
                            backendOriginLabel(backend.baseUrl),
                            style = PiType.monoMicro,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
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
                                state?.needsToken?.takeIf { it }?.let { "需要令牌" },
                            ),
                            maxLines = 2,
                        )
                        TextButton(
                            onClick = { restartTargetId = backend.id; restartError = null },
                            enabled = restartingBackendId == null,
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        ) {
                            Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(if (restartingBackendId == backend.id) "正在重启…" else "重启 Dashboard")
                        }
                        when {
                            state?.needsToken == true -> MetaText(
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
    val restartTarget = backends.firstOrNull { it.id == restartTargetId }
    if (restartTarget != null) {
        AlertDialog(
            shape = Radii.sheet,
            onDismissRequest = { if (restartingBackendId == null) restartTargetId = null },
            title = { Text("重启 ${restartTarget.name}？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("网页、手机和该 Dashboard 上的所有会话连接会暂时断开。仅当服务由 systemd 托管且配置了 Restart=always 时才会自动恢复。")
                    Text("需要此机器已完成 Live 授权；正在进行的操作可能被中断。")
                    restartError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = restartingBackendId == null,
                    onClick = {
                        restartingBackendId = restartTarget.id
                        restartError = null
                        scope.launch {
                            repo.live.restartDashboard(restartTarget.id).fold(
                                onSuccess = {
                                    restartTargetId = null
                                    snackbarHostState.showSnackbar("Dashboard 正在重启；连接会短暂断开")
                                },
                                onFailure = { error -> restartError = error.message ?: "重启请求失败" },
                            )
                            restartingBackendId = null
                        }
                    },
                ) { Text(if (restartingBackendId != null) "正在请求…" else "确认重启", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(enabled = restartingBackendId == null, onClick = { restartTargetId = null }) { Text("取消") }
            },
        )
    }
}
