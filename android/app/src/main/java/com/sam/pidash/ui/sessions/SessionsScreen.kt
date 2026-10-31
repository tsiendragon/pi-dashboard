package com.sam.pidash.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.AggregatedSlot
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.common.InsetSeparator
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.common.relativeTime
import com.sam.pidash.ui.common.AppVersionLabel
import com.sam.pidash.ui.live.LiveSessionsPanel
import com.sam.pidash.ui.live.NewLiveSessionDialog
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
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
                title = {
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        Text(
                            backends.firstOrNull()?.name ?: "机器 Dashboard",
                            style = PiType.headline,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        AppVersionLabel()
                    }
                },
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
            TabRow(
                selectedTabIndex = if (liveTab) 0 else 1,
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.primary,
                divider = { HorizontalDivider(thickness = Hairline) },
            ) {
                Tab(
                    selected = liveTab,
                    onClick = { liveTab = true },
                    text = { Text("Live Pi", style = PiType.footnote) },
                )
                Tab(
                    selected = !liveTab,
                    onClick = { liveTab = false },
                    text = { Text("Chat", style = PiType.footnote) },
                )
            }
            if (liveTab) {
                LiveSessionsPanel(repo = repo, backendId = backendId, onOpen = onOpenLive)
            } else Box(Modifier.fillMaxSize()) {
                when {
                    backends.isEmpty() -> Box(Modifier.fillMaxSize().padding(Spacing.lg)) {
                        Text(
                            "还没有服务器\n点右上角 ⚙ 添加一台",
                            modifier = Modifier.align(Alignment.Center),
                            style = PiType.footnote,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }

                    slots.isEmpty() -> Box(Modifier.fillMaxSize().padding(Spacing.lg)) {
                        Text(
                            "暂无会话",
                            modifier = Modifier.align(Alignment.Center),
                            style = PiType.footnote,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    else -> LazyColumn(
                        Modifier.fillMaxSize().padding(horizontal = Spacing.lg),
                        contentPadding = PaddingValues(top = Spacing.sm, bottom = 96.dp),
                    ) {
                        itemsIndexed(
                            items = slots,
                            key = { _, item -> "${item.key.backendId}/${item.key.slotKey}" },
                        ) { index, item ->
                            SessionRow(
                                item = item,
                                index = index,
                                count = slots.size,
                                isRunning = running.contains(item.key),
                                onClick = { onOpenSlot(item.key) },
                            )
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

/** One row of the joined Chat card: rounded only at the first and last row. */
@Composable
private fun SessionRow(
    item: AggregatedSlot,
    index: Int,
    count: Int,
    isRunning: Boolean,
    onClick: () -> Unit,
) {
    val top = if (index == 0) 10.dp else 0.dp
    val bottom = if (index == count - 1) 10.dp else 0.dp
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom))
            .background(MaterialTheme.colorScheme.surface),
    ) {
        if (index > 0) InsetSeparator()
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .heightIn(min = 48.dp)
                .padding(horizontal = Spacing.lg, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (isRunning) StatusDot(MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(
                    item.slot.title,
                    style = PiType.callout,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    BackendTag(item.backendName)
                    Text(
                        relativeTime(item.slot.updatedAt),
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
                item.slot.cwd?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = PiType.monoMicro,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun BackendTag(name: String) {
    Text(
        name,
        style = PiType.caption,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        modifier = Modifier
            .clip(Radii.chip)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = Spacing.xs + 2.dp, vertical = Spacing.xxs),
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
        title = { Text("在哪台机器新建会话？", style = PiType.headline) },
        text = {
            Column {
                backends.forEach { backend ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(backend.id) }
                            .heightIn(min = 48.dp)
                            .padding(vertical = Spacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(backend.name, Modifier.weight(1f), style = PiType.callout, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            statusText(connection[backend.id]),
                            style = PiType.caption,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
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
