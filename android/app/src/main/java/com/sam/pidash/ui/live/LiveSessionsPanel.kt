package com.sam.pidash.ui.live

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.LiveRepoCandidate
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.launch

@Composable
fun LiveSessionsPanel(repo: PiDashRepository, onOpen: (SessionKey) -> Unit) {
    val backends by repo.backends.collectAsState()
    val sessions by repo.live.sessions.collectAsState()
    val states by repo.live.backendStates.collectAsState()
    val scope = rememberCoroutineScope()
    var pairing by remember { mutableStateOf<Backend?>(null) }
    var unpairing by remember { mutableStateOf<Backend?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        item {
            Text("连接运行中的 Pi；打开时只读，不会抢占控制权。", Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall)
        }
        items(backends, key = { "backend:${it.id}" }) { backend ->
            val state = states[backend.id]
            ListItem(
                headlineContent = { Text(backend.name) },
                supportingContent = {
                    Column {
                        Text(when {
                            state == null -> "正在检查 Live Pi 连接…"
                            state.needsPairing -> "未配对 · 需要 WebUI 手机配对码"
                            !state.connected -> "Live Pi 未连接（不是空会话列表）"
                            else -> "Live Pi 已连接"
                        })
                        state?.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                },
                trailingContent = {
                    TextButton(onClick = {
                        if (state?.needsPairing != false) pairing = backend else unpairing = backend
                    }) { Text(if (state?.needsPairing != false) "配对" else "解除配对") }
                },
            )
            HorizontalDivider()
        }
        if (backends.isEmpty()) item { Text("还没有服务器，请从右上角设置添加。", Modifier.padding(16.dp)) }
        notice?.let { message -> item { Text(message, Modifier.padding(16.dp)) } }
        if (sessions.isEmpty() && backends.isNotEmpty()) item {
            val ready = backends.all { states[it.id]?.let { s -> s.connected && !s.needsPairing && s.message.isNullOrBlank() } == true }
            Text(if (ready) "暂无运行中的 Live Pi，点 + 选择工作目录并启动。"
                else "尚未取得完整列表；请先处理上方配对、连接或错误，再刷新。", Modifier.padding(16.dp))
        }
        items(sessions, key = { "live:${it.key.backendId}/${it.key.slotKey}" }) { item ->
            ListItem(
                modifier = Modifier.clickable { onOpen(item.key) },
                headlineContent = { Text((if (item.meta.pinned) "★ " else "") + item.summary.title) },
                supportingContent = {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("${item.backendName} · ${item.summary.status} · ${item.summary.claim.state}")
                        Text(item.summary.cwd, style = MaterialTheme.typography.bodySmall)
                        item.summary.model?.let { Text("${it.provider}/${it.id}", style = MaterialTheme.typography.labelSmall) }
                        if (item.meta.tags.isNotEmpty()) Text(item.meta.tags.joinToString("  ") { "#$it" })
                    }
                },
            )
            HorizontalDivider()
        }
    }
    pairing?.let { backend ->
        LivePairingDialog(repo, backend, onDismiss = { pairing = null })
    }
    unpairing?.let { backend ->
        AlertDialog(
            onDismissRequest = { unpairing = null },
            title = { Text("解除 ${backend.name} 的手机配对？") },
            text = { Text("此手机将无法控制 Live Pi，直到重新配对。普通 Chat 不受影响。") },
            confirmButton = {
                TextButton(onClick = {
                    unpairing = null
                    scope.launch {
                        repo.live.unpair(backend.id).fold(
                            onSuccess = { notice = "已解除配对" },
                            onFailure = { notice = it.message ?: "解除配对失败" },
                        )
                    }
                }) { Text("解除配对") }
            },
            dismissButton = { TextButton(onClick = { unpairing = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun LivePairingDialog(repo: PiDashRepository, backend: Backend, onDismiss: () -> Unit) {
    // Deliberately ephemeral: never saved to navigation state, logs or persistent storage.
    var code by remember(backend.id) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun close() { code = ""; onDismiss() }
    AlertDialog(
        onDismissRequest = { close() },
        title = { Text("配对 ${backend.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("在已登录的 WebUI 中打开「手机配对」，输入一次性 32 位十六进制码。不要输入主机控制 token 或 Cookie。")
                OutlinedTextField(value = code, onValueChange = { code = it.trim() },
                    label = { Text("一次性配对码") }, singleLine = true, enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && code.matches(Regex("[a-fA-F0-9]{32}")), onClick = {
                busy = true; error = null
                scope.launch {
                    val result = repo.live.pair(backend.id, code)
                    busy = false
                    result.fold(onSuccess = { close(); repo.live.refreshAll() },
                        onFailure = { error = it.message ?: "配对失败，请重新获取短期配对码" })
                }
            }) { Text("配对") }
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
