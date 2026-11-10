package com.sam.pidash.ui.live

import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.InsetSeparator
import com.sam.pidash.ui.common.MetaLine
import com.sam.pidash.ui.common.MetaAction
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.common.PulsingDot
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Tints
import com.sam.pidash.ui.theme.Spacing

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.AggregatedLiveSession
import com.sam.pidash.domain.model.LiveOrganization
import com.sam.pidash.domain.model.machineSessionSections
import com.sam.pidash.ui.common.liveConnectionLabel
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.LiveRepoCandidate
import com.sam.pidash.domain.model.liveDirectoryOptions
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.domain.model.SessionMove
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveSessionsPanel(repo: PiDashRepository, backendId: String, onOpen: (SessionKey) -> Unit) {
    val allBackends by repo.backends.collectAsState()
    val backends = allBackends.filter { it.id == backendId }
    val sessions by repo.live.sessions.collectAsState()
    val states by repo.live.backendStates.collectAsState()
    val organizations by repo.live.organization.collectAsState()
    val org = organizations[backendId] ?: LiveOrganization()
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var pendingUndo by remember { mutableStateOf<(() -> Unit)?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var connectionInfo by remember { mutableStateOf(false) }
    var signingIn by remember { mutableStateOf<Backend?>(null) }
    var signingOut by remember { mutableStateOf<Backend?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable(backendId) { mutableStateOf("") }
    var runningOnly by rememberSaveable(backendId) { mutableStateOf(false) }
    var children by rememberSaveable(backendId) { mutableStateOf(false) }
    var toggled by remember(backendId) { mutableStateOf(emptySet<String>()) }
    var managing by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf<AggregatedLiveSession?>(null) }
    var groupName by remember { mutableStateOf("") }
    var groupBusy by remember { mutableStateOf(false) }
    var sorting by remember(backendId) { mutableStateOf(false) }
    var sortBusy by remember { mutableStateOf(false) }
    var actionBusyKey by remember { mutableStateOf<SessionKey?>(null) }
    var editingRow by remember { mutableStateOf<AggregatedLiveSession?>(null) }
    var restartingRow by remember { mutableStateOf<AggregatedLiveSession?>(null) }
    var closingRow by remember { mutableStateOf<AggregatedLiveSession?>(null) }
    var rowActionError by remember { mutableStateOf<String?>(null) }
    var groupError by remember { mutableStateOf<String?>(null) }
    val sections = remember(sessions, org, query, runningOnly, children, backendId) {
        machineSessionSections(backendId, sessions, org, query, runningOnly, children)
    }
    fun move(row: AggregatedLiveSession, target: String?) {
        groupBusy = true; groupError = null
        scope.launch {
            repo.live.moveGroup(row.key, target).fold(onSuccess = { moving = null }, onFailure = { groupError = it.message })
            groupBusy = false
        }
    }
    // One feedback channel for the whole list: transient, non-blocking, and reversible
    // when the action can be undone (pin, reorder).
    LaunchedEffect(notice) {
        val message = notice ?: return@LaunchedEffect
        notice = null
        val undo = pendingUndo
        pendingUndo = null
        val result = snackbarHostState.showSnackbar(
            message = message,
            actionLabel = if (undo != null) "撤销" else null,
            withDismissAction = undo == null && message.length > 24,
            duration = SnackbarDuration.Short,
        )
        if (result == SnackbarResult.ActionPerformed) undo?.invoke()
    }
    // Pull down to re-read this machine; the same call the overflow menu uses.
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            if (!refreshing) {
                refreshing = true
                scope.launch {
                    repo.live.refreshMachine(backendId).onFailure { notice = "刷新失败：${it.message}" }
                    refreshing = false
                }
            }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val side = if (maxWidth > 720.dp) (maxWidth - 720.dp) / 2 else 0.dp
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = side, end = side, bottom = 96.dp),
    ) {
        items(backends, key = { "backend:${it.id}" }) { backend ->
            val state = states[backend.id]
            LiveConnectionStrip(
                label = liveConnectionLabel(state), connected = state?.connected == true,
                needsToken = state?.needsToken != false, error = state?.message,
                onInfo = { connectionInfo = true },
                onAuthAction = { if (state?.needsToken != false) signingIn = backend else signingOut = backend },
            )
        }
        item {
            Column(Modifier.padding(horizontal = 12.dp)) {
                SessionListControls(
                    query = query, onQueryChange = { query = it },
                    runningOnly = runningOnly, onRunningChange = { runningOnly = !runningOnly },
                    children = children, onChildrenChange = { children = !children },
                    sorting = sorting, onSortingChange = { sorting = !sorting; notice = null },
                    canGroup = org.loaded && !sorting,
                    canSort = org.loaded && !sortBusy && (sorting || (query.isBlank() && !runningOnly)),
                    onGroups = { groupError = null; managing = true },
                )
                if (!sorting && (query.isNotBlank() || runningOnly)) Text("清除搜索和筛选后可调整顺序。", style = PiType.subhead)
                if (sorting) Text("仅调整同一分组内的顺序；与网页共享。", style = PiType.subhead)
                org.error?.let { Text("分组/排序未刷新：$it", color = MaterialTheme.colorScheme.error, style = PiType.subhead) }
            }
        }
        if (backends.isEmpty()) item { Text("机器配置已删除，请返回机器列表。", Modifier.padding(16.dp)) }
        if (sections.isEmpty() && backends.isNotEmpty()) item {
            val ready = states[backendId]?.connected == true
            // An empty list is a state with an obvious next step, not a dead end: every case
            // offers the one action that actually changes the outcome.
            val filtered = query.isNotBlank() || runningOnly
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.xl, vertical = 40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                Text(
                    when {
                        !ready -> "还没有连上这台机器"
                        filtered -> "没有匹配的会话"
                        else -> "这台机器还没有 Live 会话"
                    },
                    style = PiType.callout.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    when {
                        !ready -> "配对或输入访问令牌后才会显示列表，这不代表服务器没有会话。"
                        filtered -> "清除搜索和筛选，回到完整列表。"
                        else -> "在服务器上启动一个 Pi 会话，或从这里新建。"
                    },
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.size(Spacing.xs))
                when {
                    !ready -> Button(onClick = {
                        scope.launch { repo.live.refreshMachine(backendId) }
                    }) { Text("重新连接") }
                    filtered -> Button(onClick = { query = ""; runningOnly = false }) { Text("清除筛选") }
                    else -> Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        Button(onClick = { children = true }) { Text("显示子 Agent") }
                        OutlinedButton(onClick = {
                            scope.launch { repo.live.refreshMachine(backendId) }
                        }) { Text("刷新列表") }
                    }
                }
            }
        }
        sections.forEach { section ->
            val collapsed = query.isBlank() && (section.collapsedByDefault != (section.id in toggled))
            item(key = "section:${section.id}") {
                Row(
                    Modifier.fillMaxWidth()
                        .clickable {
                            toggled = if (section.id in toggled) toggled - section.id else toggled + section.id
                        }
                        .padding(horizontal = Spacing.xl, vertical = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        section.name,
                        style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "  ${section.sessions.size}",
                        style = PiType.footnote,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (!collapsed) item(key = "card:${section.id}") {
                Column(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs)) {
                    GroupedCard {
                        section.sessions.forEachIndexed { index, row ->
                            if (index > 0) InsetSeparator()
                            val canReorder = org.loaded && !sortBusy && query.isBlank() && !runningOnly && section.id != "__subagents"
                            fun performMove(direction: SessionMove) {
                                sortBusy = true; notice = null
                                scope.launch {
                                    repo.live.moveSession(row.key, direction).fold(
                                        onSuccess = {
                                            val reverse = when (direction) {
                                                SessionMove.UP -> SessionMove.DOWN
                                                SessionMove.DOWN -> SessionMove.UP
                                                SessionMove.TOP -> SessionMove.DOWN
                                            }
                                            pendingUndo = { scope.launch { repo.live.moveSession(row.key, reverse) } }
                                            notice = "已更新「${row.summary.title}」顺序"
                                        },
                                        onFailure = { pendingUndo = null; notice = "排序失败：${it.message ?: "请刷新后重试"}" },
                                    )
                                    sortBusy = false
                                }
                            }
                            SessionRow(
                                row = row,
                                orderNumber = index + 1,
                                groupEnabled = org.loaded && !sorting,
                                canMoveUp = canReorder && index > 0,
                                canMoveDown = canReorder && index < section.sessions.lastIndex,
                                sortingMode = sorting && section.id != "__subagents",
                                busy = actionBusyKey == row.key || sortBusy,
                                onOpen = onOpen,
                                onMoveUp = { performMove(SessionMove.UP) },
                                onMoveDown = { performMove(SessionMove.DOWN) },
                                onMoveTop = { performMove(SessionMove.TOP) },
                                onTogglePin = {
                                    actionBusyKey = row.key; notice = null
                                    scope.launch {
                                        val nextPin = !row.meta.pinned
                                        repo.live.patchMeta(row.key, pinned = nextPin).fold(
                                            onSuccess = {
                                                pendingUndo = {
                                                    scope.launch { repo.live.patchMeta(row.key, pinned = !nextPin) }
                                                }
                                                notice = if (nextPin) "已置顶「${row.summary.title}」" else "已取消置顶「${row.summary.title}」"
                                            },
                                            onFailure = { pendingUndo = null; notice = "操作失败：${it.message}" },
                                        )
                                        actionBusyKey = null
                                    }
                                },
                                onReload = {
                                    actionBusyKey = row.key; notice = null
                                    scope.launch {
                                        repo.live.reload(row.key).fold(
                                            onSuccess = { notice = "已重载扩展：${row.summary.title}" },
                                            onFailure = { notice = "重载扩展失败：${it.message}" },
                                        )
                                        actionBusyKey = null
                                    }
                                },
                                onShutdown = { closingRow = row },
                                onRestart = {
                                    rowActionError = null
                                    restartingRow = row
                                },
                                onEditAppearance = {
                                    rowActionError = null
                                    editingRow = row
                                },
                                onGroup = { groupError = null; moving = row },
                            )
                        }
                    }
                }
            }
        }
    }
    SnackbarHost(
        snackbarHostState,
        Modifier.align(Alignment.BottomCenter).padding(start = Spacing.md, end = Spacing.md, bottom = 84.dp),
    )
    }
    }
    if (managing) AlertDialog(onDismissRequest = { if (!groupBusy) managing = false }, title = { Text("本机分组") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            org.groups.forEach { Text("${it.name} · ${it.sessionIds.size} 个会话") }
            Text("与网页共用分组和排序。点击会话右侧「分组」可移动；重命名、合并、删除和拖动排序暂用网页。", style = PiType.subhead)
            OutlinedTextField(groupName, { groupName = it }, label = { Text("新分组名") }, enabled = !groupBusy)
            groupError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton(enabled = !groupBusy && groupName.isNotBlank(), onClick = {
        groupBusy = true; groupError = null
        scope.launch {
            repo.live.createGroup(backendId, groupName).fold(onSuccess = { groupName = "" }, onFailure = { groupError = it.message })
            groupBusy = false
        }
    }) { Text(if (groupBusy) "提交中…" else "新建分组") } }, dismissButton = { TextButton(enabled = !groupBusy, onClick = { managing = false }) { Text("关闭") } })
    moving?.let { row -> AlertDialog(onDismissRequest = { if (!groupBusy) moving = null }, title = { Text("移动「${row.summary.title}」") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            TextButton(enabled = !groupBusy, onClick = { move(row, null) }) { Text("未分组") }
            org.groups.forEach { group -> TextButton(enabled = !groupBusy, onClick = { move(row, group.id) }) { Text(group.name) } }
            groupError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {}, dismissButton = { TextButton(enabled = !groupBusy, onClick = { moving = null }) { Text("取消") } }) }
    editingRow?.let { target ->
        LiveMetadataDialog(
            meta = target.meta,
            busy = actionBusyKey == target.key,
            error = rowActionError,
            onDismiss = { if (actionBusyKey == null) editingRow = null },
            initialTitle = target.summary.title,
        ) { tags, pinned, emoji, color, nextTitle ->
            actionBusyKey = target.key; rowActionError = null
            scope.launch {
                if (nextTitle != null) {
                    val renamed = repo.live.rename(target.key, nextTitle)
                    if (renamed.isFailure) {
                        rowActionError = renamed.exceptionOrNull()?.message ?: "重命名失败"
                        actionBusyKey = null
                        return@launch
                    }
                }
                repo.live.patchMeta(target.key, tags, pinned, emoji, color).fold(
                    onSuccess = {
                        editingRow = null
                        notice = "已更新「${nextTitle ?: target.summary.title}」装扮与名称"
                    },
                    onFailure = { rowActionError = if (nextTitle != null) "名称已更新，但装扮保存失败：${it.message ?: "请重试"}" else it.message ?: "保存失败" },
                )
                actionBusyKey = null
            }
        }
    }
    closingRow?.let { target ->
        LiveShutdownDialog(repo, target.key, target.summary.title,
            onDismiss = { closingRow = null },
            onAccepted = {
                closingRow = null
                notice = "已发送关闭请求：${target.summary.title}，进程退出后将从列表移除"
                scope.launch { repo.live.refreshMachine(backendId) }
            },
        )
    }
    restartingRow?.let { target ->
        val busy = actionBusyKey == target.key
        AlertDialog(
            onDismissRequest = { if (!busy) restartingRow = null },
            title = { Text("重启 Pi 进程？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("将重启「${target.summary.title}」的 Pi 进程，尝试从原会话恢复。")
                    Text("在途任务可能中断；重启失败时请刷新列表确认状态，避免重复操作。", style = PiType.subhead, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    rowActionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    actionBusyKey = target.key; rowActionError = null
                    scope.launch {
                        val claimed = if (repo.live.leases.value.containsKey(target.key)) Result.success(Unit) else repo.live.claim(target.key)
                        if (claimed.isFailure) {
                            rowActionError = claimed.exceptionOrNull()?.message ?: "取得控制权失败"
                            actionBusyKey = null
                            return@launch
                        }
                        repo.live.restart(target.key).fold(
                            onSuccess = { newKey ->
                                restartingRow = null
                                notice = "已重启「${target.summary.title}」，正在恢复原 session"
                                repo.live.refreshAll()
                                if (newKey != null) onOpen(newKey)
                            },
                            onFailure = { rowActionError = it.message ?: "重启失败" },
                        )
                        actionBusyKey = null
                    }
                }) { Text("确认重启进程") }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { restartingRow = null }) { Text("取消") }
            },
        )
    }
    if (connectionInfo) {
        AlertDialog(
            onDismissRequest = { connectionInfo = false },
            title = { Text("连接与只读说明") },
            text = { Text("打开会话只读，不会抢占现有会话。需要控制或执行操作时，仍按原有流程获取控制权及授权。") },
            confirmButton = { TextButton(onClick = { connectionInfo = false }) { Text("知道了") } },
        )
    }
    signingIn?.let { backend ->
        LiveTokenDialog(repo, backend, onDismiss = { signingIn = null })
    }
    signingOut?.let { backend ->
        AlertDialog(
            onDismissRequest = { signingOut = null },
            title = { Text("断开 ${backend.name}？") },
            text = { Text("这台手机将无法控制 Live Pi，直到重新输入访问令牌。普通 Chat 不受影响。") },
            confirmButton = {
                TextButton(onClick = {
                    signingOut = null
                    scope.launch {
                        repo.live.disconnect(backend.id).fold(
                            onSuccess = { notice = "已断开连接" },
                            onFailure = { notice = it.message ?: "断开失败" },
                        )
                    }
                }) { Text("断开") }
            },
            dismissButton = { TextButton(onClick = { signingOut = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun LiveTokenDialog(repo: PiDashRepository, backend: Backend, onDismiss: () -> Unit) {
    // The token is long-lived, so it is deliberately not stored: only the HttpOnly cookie is.
    var token by remember(backend.id) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun close() { token = ""; onDismiss() }
    AlertDialog(
        onDismissRequest = { close() },
        title = { Text("登录 ${backend.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("粘贴这台机器的访问令牌（64 位十六进制）。它就在 Dashboard 的 ~/.pi/agent/run/pi-dashboard/live-control-token 文件里——与网页登录用的是同一个令牌。")
                Text("令牌只用来换取一次会话 Cookie，不会被保存在手机上；会话 7 天不用才会失效。", style = PiType.micro, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(value = token, onValueChange = { token = it.trim() },
                    label = { Text("访问令牌") }, singleLine = true, enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && token.trim().matches(Regex("[a-fA-F0-9]{64}")), onClick = {
                busy = true; error = null
                scope.launch {
                    val result = repo.live.connect(backend.id, token)
                    busy = false
                    result.fold(onSuccess = { close(); repo.live.refreshAll() },
                        onFailure = { error = it.message ?: "登录失败，请核对令牌" })
                }
            }) { Text("登录") }
        },
        dismissButton = { TextButton(onClick = { close() }) { Text("取消") } },
    )
}

@Composable
fun NewLiveSessionDialog(
    repo: PiDashRepository,
    backends: List<Backend>,
    onDismiss: () -> Unit,
    onOpen: (SessionKey) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var backendId by remember { mutableStateOf(backends.firstOrNull()?.id.orEmpty()) }
    var cwd by remember(backendId) { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var thinking by remember { mutableStateOf("") }
    var roots by remember(backendId) { mutableStateOf(emptyList<String>()) }
    var candidates by remember(backendId) { mutableStateOf(emptyList<LiveRepoCandidate>()) }
    var loading by remember(backendId) { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var waiting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var optionsError by remember(backendId) { mutableStateOf<String?>(null) }
    var backendMenu by remember { mutableStateOf(false) }
    var cwdMenu by remember(backendId) { mutableStateOf(false) }
    val directoryOptions = remember(candidates, roots) { liveDirectoryOptions(candidates, roots) }

    LaunchedEffect(backendId) {
        cwd = ""; roots = emptyList(); candidates = emptyList(); optionsError = null; error = null
        waiting = false; loading = true
        val options = repo.live.startOptions(backendId)
        roots = options.getOrNull()?.roots.orEmpty()
        val repos = repo.live.candidates(backendId)
        candidates = repos.getOrNull().orEmpty()
        optionsError = listOfNotNull(options.exceptionOrNull()?.message, repos.exceptionOrNull()?.message)
            .joinToString("\n").takeIf { it.isNotBlank() }
        loading = false
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("新建 Live Pi") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box {
                    OutlinedButton(enabled = !busy && !waiting, onClick = { backendMenu = true }) {
                        Text(backends.firstOrNull { it.id == backendId }?.name ?: "选择服务器")
                    }
                    DropdownMenu(expanded = backendMenu, onDismissRequest = { backendMenu = false }) {
                        backends.forEach { backend -> DropdownMenuItem(text = { Text(backend.name) }, onClick = {
                            backendId = backend.id; backendMenu = false
                        }) }
                    }
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                optionsError?.let { Text("目录选项加载失败：$it\n可手动填写绝对路径；启动权限由服务器校验。", color = MaterialTheme.colorScheme.error) }
                OutlinedTextField(value = cwd, onValueChange = { cwd = it }, label = { Text("工作目录（绝对路径）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting, singleLine = true)
                if (!loading && cwd.isBlank() && directoryOptions.isNotEmpty()) {
                    Text("快捷选择", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    directoryOptions.take(3).forEach { option ->
                        LiveDirectoryChoice(option, enabled = !busy && !waiting, onSelect = { cwd = option.path })
                    }
                }
                TextButton(enabled = !busy && !waiting && !loading && directoryOptions.isNotEmpty(),
                    onClick = { cwdMenu = true }) {
                    Text(if (directoryOptions.isEmpty()) "搜索目录" else "搜索全部目录（${directoryOptions.size}）")
                }
                if (!loading && directoryOptions.isEmpty() && optionsError == null) {
                    Text("服务器暂无目录建议，可直接填写绝对路径。", style = PiType.footnote,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("标题（可选）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting)
                OutlinedTextField(value = model, onValueChange = { model = it }, label = { Text("模型（可选，provider/id）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting)
                Text("思考强度（可选）", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    (listOf("" to "默认") + THINKING_LADDER_LEVELS.map { it.id to it.title.substringBefore(" · ") }).forEach { (id, label) ->
                        FilterChip(
                            selected = thinking == id,
                            enabled = !busy && !waiting,
                            onClick = { thinking = id },
                            label = { Text(label) },
                        )
                    }
                }
                OutlinedTextField(value = thinking, onValueChange = { thinking = it }, label = { Text("思考等级（可选）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting)
                Text("启动失败不会创建普通 Chat，也不会自动重试。", style = PiType.subhead)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (waiting) {
                    Text("启动请求已接受，正在等待进程注册。请刷新列表查看，不要重复启动。")
                    TextButton(onClick = { scope.launch { repo.live.refreshAll() } }) { Text("刷新列表") }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && !waiting && backendId.isNotBlank() && cwd.trim().startsWith("/"), onClick = {
                busy = true; error = null
                scope.launch {
                    val result = repo.live.start(backendId, cwd.trim(), title.trim(), model.trim(), thinking.trim())
                    busy = false
                    result.fold(onSuccess = { key ->
                        repo.live.refreshAll()
                        if (key != null) onOpen(key) else waiting = true
                    }, onFailure = {
                        error = "${it.message ?: "启动失败"}\n若超时或结果不确定，请先关闭对话框并刷新列表确认，再决定是否重试。"
                    })
                }
            }) { Text("启动 Live Pi") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(if (waiting) "返回列表" else "取消") } },
    )
    if (cwdMenu) {
        LiveDirectoryPicker(
            serverName = backends.firstOrNull { it.id == backendId }?.name ?: backendId,
            options = directoryOptions, currentPath = cwd,
            onSelect = { cwd = it; cwdMenu = false }, onDismiss = { cwdMenu = false },
        )
    }
}

/**
 * One row inside a grouped card: order number, emoji avatar, title, mono cwd and tags.
 * Secondary actions live behind a trailing ⋯ menu (and long press) so a row stays two to
 * three text lines tall; sorting mode swaps the menu for ↑ ↓ arrows.
 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun SessionRow(
    row: AggregatedLiveSession,
    orderNumber: Int,
    groupEnabled: Boolean,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    sortingMode: Boolean,
    busy: Boolean,
    onOpen: (SessionKey) -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onMoveTop: () -> Unit,
    onTogglePin: () -> Unit,
    onReload: () -> Unit,
    onRestart: () -> Unit,
    onShutdown: () -> Unit,
    onEditAppearance: () -> Unit,
    onGroup: () -> Unit,
) {
    val running = row.summary.status == "running"
    val subagent = row.summary.role == "subagent" || row.summary.parentSessionId != null
    val accentColor = parseHexColor(row.meta.color) ?: MaterialTheme.colorScheme.primary
    val emojiText = row.meta.emoji.takeIf { it.isNotBlank() } ?: if (subagent) "🤖" else "💬"
    var actions by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current

    Row(
        Modifier.fillMaxWidth()
            .semantics(mergeDescendants = true) {}
            .combinedClickable(
                onClickLabel = "打开会话",
                onLongClickLabel = "会话操作",
                onClick = { onOpen(row.key) },
                onLongClick = {
                    if (!subagent) {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        actions = true
                    }
                },
            )
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            orderNumber.toString().padStart(2, '0'),
            style = PiType.monoMicro,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // Clickable emoji & color avatar box
        Box(
            Modifier.size(30.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                .border(
                    width = if (row.meta.color.isNotBlank()) 2.dp else 1.dp,
                    color = if (row.meta.color.isNotBlank()) accentColor else MaterialTheme.colorScheme.outline.copy(alpha = Tints.Border),
                    shape = RoundedCornerShape(8.dp),
                )
                .clickable(enabled = !busy) { onEditAppearance() },
            contentAlignment = Alignment.Center,
        ) {
            Text(emojiText, style = PiType.callout)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (running) {
                    PulsingDot(MaterialTheme.colorScheme.primary, size = 5.dp, contentDescription = "运行中")
                }
                Text(
                    row.summary.title,
                    style = PiType.callout.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (row.meta.pinned) {
                    Text("📌", style = PiType.caption)
                }
            }
            Text(
                row.summary.cwd,
                style = PiType.monoMicro,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            MetaLine(
                listOfNotNull(
                    row.summary.claim.state.takeIf { it == "claimed" }?.let { "已接管" },
                    row.summary.model?.let { "${it.provider}/${it.id}" },
                ) + row.meta.tags.take(2).map { "#$it" }
            )
        }
        if (sortingMode) {
            RowIconButton(icon = Icons.Filled.KeyboardArrowUp, label = "上移", enabled = canMoveUp && !busy, onClick = onMoveUp)
            RowIconButton(icon = Icons.Filled.KeyboardArrowDown, label = "下移", enabled = canMoveDown && !busy, onClick = onMoveDown)
        }
        if (!subagent) {
            IconButton(onClick = { actions = true }, modifier = Modifier.size(48.dp)) {
                Icon(
                    Icons.Filled.MoreVert,
                    contentDescription = "会话操作",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    if (actions) {
        ModalBottomSheet(onDismissRequest = { actions = false }) {
            SessionActionsSheet(
                row = row,
                busy = busy,
                groupEnabled = groupEnabled,
                sortingMode = sortingMode,
                canMoveTop = canMoveUp,
                onDismiss = { actions = false },
                onReload = onReload,
                onRestart = onRestart,
                onRename = onEditAppearance,
                onGroup = onGroup,
                onPin = onTogglePin,
                onMoveTop = onMoveTop,
                onShutdown = onShutdown,
            )
        }
    }
}

/**
 * The row's secondary actions as a bottom sheet: thumb-reachable, 48 dp rows, destructive
 * action last and in red. A dropdown anchored to a 32 dp icon is fine on desktop, not here.
 */
@Composable
private fun SessionActionsSheet(
    row: AggregatedLiveSession,
    busy: Boolean,
    groupEnabled: Boolean,
    sortingMode: Boolean,
    canMoveTop: Boolean,
    onDismiss: () -> Unit,
    onReload: () -> Unit,
    onRestart: () -> Unit,
    onRename: () -> Unit,
    onGroup: () -> Unit,
    onPin: () -> Unit,
    onMoveTop: () -> Unit,
    onShutdown: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(bottom = Spacing.lg)) {
        Column(Modifier.padding(horizontal = Spacing.lg)) {
            Text(
                row.summary.title,
                style = PiType.callout.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                row.summary.cwd,
                style = PiType.monoMicro,
                color = scheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        HorizontalDivider(Modifier.padding(vertical = Spacing.sm), color = scheme.outline.copy(alpha = Tints.Hairline))
        val reconnecting = row.summary.status == "reconnecting"
        SheetAction(Icons.Filled.Refresh, "重载扩展", enabled = !busy && !reconnecting) { onDismiss(); onReload() }
        SheetAction(Icons.Filled.PlayArrow, "重启 Pi 进程", enabled = !busy && !reconnecting) { onDismiss(); onRestart() }
        HorizontalDivider(Modifier.padding(vertical = Spacing.xs), color = scheme.outline.copy(alpha = Tints.Hairline))
        SheetAction(Icons.Filled.Edit, "改名 / 装扮", enabled = !busy) { onDismiss(); onRename() }
        SheetAction(Icons.AutoMirrored.Filled.List, "移动到分组", enabled = groupEnabled && !busy) { onDismiss(); onGroup() }
        if (sortingMode) {
            SheetAction(
                Icons.Filled.KeyboardArrowUp,
                "置顶本组",
                enabled = canMoveTop && !busy,
            ) { onDismiss(); onMoveTop() }
            SheetAction(
                Icons.Filled.Star,
                if (row.meta.pinned) "取消置顶" else "置顶",
                enabled = !busy,
            ) { onDismiss(); onPin() }
        }
        HorizontalDivider(Modifier.padding(vertical = Spacing.xs), color = scheme.outline.copy(alpha = Tints.Hairline))
        SheetAction(
            Icons.Filled.Close,
            "关闭会话",
            enabled = !busy && row.summary.canShutdown,
            destructive = true,
        ) { onDismiss(); onShutdown() }
    }
}

@Composable
private fun SheetAction(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val tint = when {
        !enabled -> scheme.onSurfaceVariant.copy(alpha = 0.4f)
        destructive -> scheme.error
        else -> scheme.onSurface
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = Spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = tint)
        Text(label, style = PiType.callout, color = tint)
    }
}

@Composable
private fun RowIconButton(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(44.dp)) {
        Icon(
            icon,
            contentDescription = label,
            modifier = Modifier.size(20.dp),
            tint = if (enabled) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
        )
    }
}
