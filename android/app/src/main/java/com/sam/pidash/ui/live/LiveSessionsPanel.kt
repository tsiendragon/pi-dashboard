package com.sam.pidash.ui.live

import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.InsetSeparator
import com.sam.pidash.ui.common.MetaLine
import com.sam.pidash.ui.common.MetaAction
import com.sam.pidash.ui.common.StatusDot
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.AggregatedLiveSession
import com.sam.pidash.domain.model.LiveOrganization
import com.sam.pidash.domain.model.machineSessionSections
import com.sam.pidash.ui.common.liveConnectionLabel
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.LiveRepoCandidate
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.domain.model.SessionMove
import kotlinx.coroutines.launch

@Composable
fun LiveSessionsPanel(repo: PiDashRepository, backendId: String, onOpen: (SessionKey) -> Unit) {
    val allBackends by repo.backends.collectAsState()
    val backends = allBackends.filter { it.id == backendId }
    val sessions by repo.live.sessions.collectAsState()
    val states by repo.live.backendStates.collectAsState()
    val organizations by repo.live.organization.collectAsState()
    val org = organizations[backendId] ?: LiveOrganization()
    val scope = rememberCoroutineScope()
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
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        items(backends, key = { "backend:${it.id}" }) { backend ->
            val state = states[backend.id]
            ListItem(headlineContent = { Text(liveConnectionLabel(state)) }, supportingContent = {
                Column {
                    Text("打开只读，不会抢占现有会话。", style = MaterialTheme.typography.bodySmall)
                    state?.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }, trailingContent = { TextButton(onClick = {
                if (state?.needsToken != false) signingIn = backend else signingOut = backend
            }) { Text(if (state?.needsToken != false) "登录" else "断开") } })
        }
        item {
            Column(Modifier.padding(horizontal = 12.dp)) {
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("搜索标题 / 路径 / 模型 / 分组 / #标签") }, singleLine = true, enabled = !sorting)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(runningOnly, { runningOnly = !runningOnly }, enabled = !sorting, label = { Text("工作中") })
                    FilterChip(children, { children = !children }, enabled = !sorting, label = { Text("子 Agent") })
                    TextButton(enabled = org.loaded && !sorting, onClick = { groupError = null; managing = true }) { Text("分组") }
                    FilterChip(
                        selected = sorting,
                        enabled = org.loaded && !sortBusy && (sorting || (query.isBlank() && !runningOnly)),
                        onClick = { sorting = !sorting; notice = null },
                        label = { Text(if (sorting) "完成排序" else "排序模式") },
                    )
                }
                if (!sorting && (query.isNotBlank() || runningOnly)) Text("清除搜索和筛选后可调整顺序。", style = MaterialTheme.typography.bodySmall)
                if (sorting) Text("仅调整同一分组内的顺序；与网页共享。", style = MaterialTheme.typography.bodySmall)
                org.error?.let { Text("分组/排序未刷新：$it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
        if (backends.isEmpty()) item { Text("机器配置已删除，请返回机器列表。", Modifier.padding(16.dp)) }
        notice?.let { message -> item { Text(message, Modifier.padding(16.dp)) } }
        if (sections.isEmpty() && backends.isNotEmpty()) item {
            val ready = states[backendId]?.connected == true
            Text(when {
                !ready -> "尚未取得 Live 列表，请先完成配对/连接；这不代表服务器没有会话。"
                query.isNotBlank() || runningOnly -> "没有匹配的会话，请清除搜索或筛选。"
                else -> "本机暂无主 Live 会话；可显示子 Agent，或点 + 选择目录启动。"
            }, Modifier.padding(16.dp))
        }
        sections.forEach { section ->
            val collapsed = query.isBlank() && (section.collapsedByDefault != (section.id in toggled))
            item(key = "section:${section.id}") {
                Row(
                    Modifier.fillMaxWidth()
                        .clickable {
                            toggled = if (section.id in toggled) toggled - section.id else toggled + section.id
                        }
                        .padding(horizontal = Spacing.xl, vertical = Spacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        section.name.uppercase(),
                        style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "  ${section.sessions.size}",
                        style = PiType.footnote,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
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
                                        onSuccess = { notice = "已更新「${row.summary.title}」顺序" },
                                        onFailure = { notice = "排序失败：${it.message ?: "请刷新后重试"}" },
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
                                            onSuccess = { notice = if (nextPin) "已置顶「${row.summary.title}」" else "已取消置顶「${row.summary.title}」" },
                                            onFailure = { notice = "操作失败：${it.message}" },
                                        )
                                        actionBusyKey = null
                                    }
                                },
                                onReload = {
                                    actionBusyKey = row.key; notice = null
                                    scope.launch {
                                        repo.live.reload(row.key).fold(
                                            onSuccess = { notice = "已发送重载指令：${row.summary.title}" },
                                            onFailure = { notice = "重载失败：${it.message}" },
                                        )
                                        actionBusyKey = null
                                    }
                                },
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
    if (managing) AlertDialog(onDismissRequest = { if (!groupBusy) managing = false }, title = { Text("本机分组") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            org.groups.forEach { Text("${it.name} · ${it.sessionIds.size} 个会话") }
            Text("与网页共用分组和排序。点击会话右侧「分组」可移动；重命名、合并、删除和拖动排序暂用网页。", style = MaterialTheme.typography.bodySmall)
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
    restartingRow?.let { target ->
        val busy = actionBusyKey == target.key
        AlertDialog(
            onDismissRequest = { if (!busy) restartingRow = null },
            title = { Text("⚡ 重启 Pi 会话进程？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("将重启「${target.summary.title}」的 Pi 进程，尝试从原会话恢复。")
                    Text("在途任务可能中断；重启失败时请刷新列表确认状态，避免重复操作。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    var cwd by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var thinking by remember { mutableStateOf("") }
    var roots by remember { mutableStateOf(emptyList<String>()) }
    var candidates by remember { mutableStateOf(emptyList<LiveRepoCandidate>()) }
    var loading by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var waiting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var optionsError by remember { mutableStateOf<String?>(null) }
    var backendMenu by remember { mutableStateOf(false) }
    var cwdMenu by remember { mutableStateOf(false) }

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
                Box {
                    TextButton(enabled = !busy && !waiting && (roots.isNotEmpty() || candidates.isNotEmpty()),
                        onClick = { cwdMenu = true }) { Text("从服务器根目录 / 项目选择") }
                    DropdownMenu(expanded = cwdMenu, onDismissRequest = { cwdMenu = false }) {
                        candidates.forEach { candidate -> DropdownMenuItem(
                            text = { Column { Text(candidate.name); Text(candidate.path, style = MaterialTheme.typography.bodySmall) } },
                            onClick = { cwd = candidate.path; cwdMenu = false },
                        ) }
                        roots.forEach { root -> DropdownMenuItem(text = { Text(root) }, onClick = { cwd = root; cwdMenu = false }) }
                    }
                }
                OutlinedTextField(value = cwd, onValueChange = { cwd = it }, label = { Text("工作目录（绝对路径）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting, singleLine = true)
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("标题（可选）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting)
                OutlinedTextField(value = model, onValueChange = { model = it }, label = { Text("模型（可选，provider/id）") },
                    modifier = Modifier.fillMaxWidth(), enabled = !busy && !waiting)
                Text("思考强度（可选）", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                Text("启动失败不会创建普通 Chat，也不会自动重试。", style = MaterialTheme.typography.bodySmall)
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
}

/** One row inside a grouped card: emoji + color avatar, title, mono cwd, and direct mobile action bar. */
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
    onEditAppearance: () -> Unit,
    onGroup: () -> Unit,
) {
    val running = row.summary.status == "running"
    val subagent = row.summary.role == "subagent" || row.summary.parentSessionId != null
    val accentColor = parseHexColor(row.meta.color) ?: MaterialTheme.colorScheme.primary
    val emojiText = row.meta.emoji.takeIf { it.isNotBlank() } ?: if (subagent) "🤖" else "💬"

    Column(
        Modifier.fillMaxWidth()
            .clickable { onOpen(row.key) }
            .padding(horizontal = Spacing.md, vertical = Spacing.md),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                orderNumber.toString().padStart(2, '0'),
                style = PiType.monoMicro,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
            // Clickable emoji & color avatar box
            Box(
                Modifier.size(36.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(9.dp))
                    .border(
                        width = if (row.meta.color.isNotBlank()) 2.dp else 1.dp,
                        color = if (row.meta.color.isNotBlank()) accentColor else MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
                        shape = RoundedCornerShape(9.dp),
                    )
                    .clickable(enabled = !busy) { onEditAppearance() },
                contentAlignment = Alignment.Center,
            ) {
                Text(emojiText, style = MaterialTheme.typography.bodyLarge)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (running) {
                        StatusDot(MaterialTheme.colorScheme.primary)
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
        }

        // Direct mobile action bar (matches mockup's session-row-actions)
        if (!subagent) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                RowPillButton(text = "↑", enabled = canMoveUp && !busy, onClick = onMoveUp)
                RowPillButton(text = "↓", enabled = canMoveDown && !busy, onClick = onMoveDown)
                if (sortingMode) {
                    RowPillButton(text = "置顶本组", enabled = canMoveUp && !busy, onClick = onMoveTop)
                    RowPillButton(text = if (row.meta.pinned) "取消置顶" else "置顶", enabled = !busy, onClick = onTogglePin)
                }
                RowPillButton(
                    text = "重载",
                    enabled = !busy && row.summary.status != "reconnecting",
                    onClick = onReload,
                )
                RowPillButton(
                    text = "重启",
                    enabled = !busy && row.summary.status != "reconnecting",
                    onClick = onRestart,
                )
                RowPillButton(text = "改名 / 装扮", enabled = !busy, onClick = onEditAppearance)
                RowPillButton(text = "分组", enabled = groupEnabled && !busy, onClick = onGroup)
            }
        }
    }
}

@Composable
private fun RowPillButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (enabled) 0.7f else 0.3f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = if (enabled) 0.35f else 0.15f)),
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            style = PiType.micro.copy(fontWeight = FontWeight.Medium),
            color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
        )
    }
}
