package com.sam.pidash.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.AggregatedSlot
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.common.relativeTime
import com.sam.pidash.ui.common.AppVersionLabel
import com.sam.pidash.ui.live.LiveSessionsPanel
import com.sam.pidash.ui.live.NewLiveSessionDialog
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    repo: PiDashRepository,
    backendId: String,
    onBack: () -> Unit,
    onOpenSlot: (SessionKey) -> Unit,
    onOpenLive: (SessionKey) -> Unit,
    onOpenBackends: () -> Unit,
) {
    val allSlots by repo.aggregatedSlots.collectAsState()
    val allBackends by repo.backends.collectAsState()
    val slots = allSlots.filter { it.key.backendId == backendId }
    val backends = allBackends.filter { it.id == backendId }
    val connection by repo.connection.collectAsState()
    val running by repo.running.collectAsState()
    val scope = rememberCoroutineScope()
    var showNew by remember { mutableStateOf(false) }
    var liveTab by rememberSaveable { mutableStateOf(true) }

    LaunchedEffect(repo, backendId) {
        repo.live.refreshMachine(backendId)
        repo.refreshAll()
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        topBar = {
            TopAppBar(
                title = { Column { Text(backends.firstOrNull()?.name ?: "机器 Dashboard", maxLines = 1); AppVersionLabel() } },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回机器列表") } },
                actions = {
                    IconButton(onClick = {
                        scope.launch {
                            if (liveTab) repo.live.refreshMachine(backendId) else repo.refreshAll()
                        }
                    }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                    }
                    IconButton(onClick = onOpenBackends) {
                        Icon(Icons.Filled.Settings, contentDescription = "服务器")
                    }
                },
            )
        },
        floatingActionButton = {
            if (backends.isNotEmpty()) {
                FloatingActionButton(onClick = { showNew = true }) {
                    Icon(Icons.Filled.Add, contentDescription = "新建会话")
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = if (liveTab) 0 else 1) {
                Tab(selected = liveTab, onClick = { liveTab = true }, text = { Text("Live Pi") })
                Tab(selected = !liveTab, onClick = { liveTab = false }, text = { Text("Chat") })
            }
            if (liveTab) {
                LiveSessionsPanel(repo = repo, backendId = backendId, onOpen = onOpenLive)
            } else Box(Modifier.fillMaxSize()) {
                when {
                    backends.isEmpty() -> Text(
                        "还没有服务器\n点右上角 ⚙ 添加一台",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    slots.isEmpty() -> Text(
                        "暂无会话",
                        modifier = Modifier.align(Alignment.Center),
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    else -> LazyColumn(
                        Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(bottom = 88.dp),
                    ) {
                        items(slots, key = { "${it.key.backendId}/${it.key.slotKey}" }) { item ->
                            SessionRow(
                                item = item,
                                isRunning = running.contains(item.key),
                                onClick = { onOpenSlot(item.key) },
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }

    if (showNew && liveTab) {
        NewLiveSessionDialog(
            repo = repo,
            backends = backends,
            onDismiss = { showNew = false },
            onOpen = { key -> showNew = false; onOpenLive(key) },
        )
    } else if (showNew) {
        NewSessionDialog(
            backends = backends,
            connection = connection,
            onDismiss = { showNew = false },
            onPick = { backendId ->
                scope.launch {
                    val key = repo.createSlot(backendId)
                    showNew = false
                    if (key != null) onOpenSlot(key)
                }
            },
        )
    }
}

@Composable
private fun SessionRow(item: AggregatedSlot, isRunning: Boolean, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (isRunning) {
                    Box(
                        Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(Color(0xFF2E7D32)),
                    )
                    Text("  ")
                }
                Text(
                    item.slot.title,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
            }
        },
        supportingContent = {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    BackendTag(item.backendName)
                    Text(
                        "  ${relativeTime(item.slot.updatedAt)}",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                item.slot.cwd?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                }
            }
        },
    )
}

@Composable
private fun BackendTag(name: String) {
    Text(
        name,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun NewSessionDialog(
    backends: List<Backend>,
    connection: Map<String, ConnectionState>,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("在哪台机器新建会话？") },
        text = {
            Column {
                backends.forEach { backend ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(backend.id) }
                            .padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(backend.name, Modifier.weight(1f))
                        Text(
                            statusText(connection[backend.id]),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

private fun statusText(state: ConnectionState?): String = when (state) {
    ConnectionState.Connected -> "在线"
    ConnectionState.Connecting -> "连接中"
    ConnectionState.Error -> "离线"
    ConnectionState.Disconnected -> "未连接"
    null -> ""
}
