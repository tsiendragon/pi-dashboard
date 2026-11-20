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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.domain.model.MachineLoadState
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(repo: PiDashRepository, onOpen: (String) -> Unit, onSettings: () -> Unit) {
    val backends by repo.backends.collectAsState()
    val sessions by repo.live.sessions.collectAsState()
    val states by repo.live.backendStates.collectAsState()
    val loads by repo.live.machineLoads.collectAsState()
    val chat by repo.connection.collectAsState()
    val scope = rememberCoroutineScope()
    // Keep the host metrics current while the list is on screen. One cheap sample
    // per machine every 20s; leaving the screen cancels the loop.
    LaunchedEffect(backends.map { it.id }) {
        while (isActive) {
            repo.live.refreshMachineLoads()
            delay(20_000)
        }
    }
    val snackbarHostState = remember { SnackbarHostState() }
    var restartTargetId by remember { mutableStateOf<String?>(null) }
    var restartingBackendId by remember { mutableStateOf<String?>(null) }
    var restartError by remember { mutableStateOf<String?>(null) }
    Scaffold(containerColor = MaterialTheme.colorScheme.background, snackbarHost = { SnackbarHost(snackbarHostState) }, topBar = {
        CompactPageHeader(title = "机器 / Dashboard", actions = {
            CompactHeaderAction(Icons.Default.Refresh, "刷新机器状态与负载") {
                scope.launch { repo.live.refreshAll() }
                scope.launch { repo.live.refreshMachineLoads() }
            }
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
                        MachineLoadSummary(loads[backend.id])
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

@Composable
private fun MachineLoadSummary(state: MachineLoadState?) {
    val load = state?.load
    if (load == null) {
        if (state?.error != null) {
            MetaText("机器负载不可用：${loadErrorHint(state.error)}", tint = MaterialTheme.colorScheme.error, maxLines = 2)
        } else {
            MetaText("正在读取机器负载…")
        }
        return
    }
    val cpuHot = (load.cpuPercent ?: 0.0) >= 90.0
    val memoryHot = (load.memoryUsedPercent ?: 0.0) >= 85.0
    val loadHot = load.load1 != null && load.cpuCount > 0 && load.load1 / load.cpuCount >= 1.5
    val normal = MaterialTheme.colorScheme.primary
    val hot = MaterialTheme.colorScheme.error
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        LoadMeter(
            label = "CPU",
            value = formatPercent(load.cpuPercent),
            fraction = load.cpuPercent?.let { (it / 100.0).toFloat() },
            tone = if (cpuHot) hot else normal,
            modifier = Modifier.weight(1f),
        )
        LoadMeter(
            label = "内存",
            value = formatPercent(load.memoryUsedPercent),
            fraction = load.memoryUsedPercent?.let { (it / 100.0).toFloat() },
            tone = if (memoryHot) hot else normal,
            modifier = Modifier.weight(1f),
        )
    }
    load.load1?.let {
        Text(
            "负载 ${formatLoad(it)}" + if (load.cpuCount > 0) " · ${load.cpuCount} 核" else "",
            style = PiType.caption,
            color = if (loadHot) hot else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
    if (load.memoryTotalBytes > 0) {
        Text(
            "内存 ${formatGb(load.memoryUsedBytes)} / ${formatGb(load.memoryTotalBytes)} GB",
            style = PiType.micro,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
    if (state.error != null) {
        MetaText("负载刷新失败，仍是上次读数：${loadErrorHint(state.error)}", tint = hot, maxLines = 2)
    } else when {
        memoryHot -> MetaText("内存接近上限，建议先清理或暂停不用的会话", tint = hot, maxLines = 2)
        cpuHot -> MetaText("CPU 接近满载，建议减少并发会话", tint = hot, maxLines = 2)
        loadHot -> MetaText("系统负载偏高，建议减少并发会话", tint = hot, maxLines = 2)
    }
}

@Composable
private fun LoadMeter(label: String, value: String, fraction: Float?, tone: Color, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Text(value, style = PiType.action, color = tone, maxLines = 1)
        }
        if (fraction != null) {
            LinearProgressIndicator(
                progress = { fraction.coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(3.dp),
                color = tone,
                trackColor = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline),
            )
        }
    }
}

private fun formatPercent(value: Double?): String {
    if (value == null || !value.isFinite()) return "—"
    return if (value < 10) String.format(Locale.US, "%.1f%%", value)
    else String.format(Locale.US, "%.0f%%", value)
}

private fun formatLoad(value: Double): String =
    String.format(Locale.US, "%.1f", value)

private fun formatGb(bytes: Long): String =
    String.format(Locale.US, "%.1f", bytes / 1073741824.0)

private fun loadErrorHint(error: String): String =
    if (error.contains("接口") || error.contains("JSON")) "此 Dashboard 版本可能过旧，请更新服务器"
    else error
