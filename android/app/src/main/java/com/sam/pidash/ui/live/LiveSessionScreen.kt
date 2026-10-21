package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.MoreVert
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.data.remote.ImageAttachments
import com.sam.pidash.domain.model.LiveImage
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.externalUrlAllowed
import com.sam.pidash.data.remote.projectLiveTimeline
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveSessionScreen(
    repo: PiDashRepository,
    sessionKey: SessionKey,
    onBack: () -> Unit,
    onOpenLive: (SessionKey) -> Unit,
) {
    val live = repo.live
    val sessions by live.sessions.collectAsState()
    val details by live.details.collectAsState()
    val leases by live.leases.collectAsState()
    val errors by live.errors.collectAsState()
    val backendStates by live.backendStates.collectAsState()
    val aggregate = sessions.firstOrNull { it.key == sessionKey }
    val detail = details[sessionKey]
    val summary = detail?.summary ?: aggregate?.summary
    val owned = leases.containsKey(sessionKey)
    val heldElsewhere = summary?.claim?.state == "claimed" && !owned
    val timeline = remember(detail) { detail?.let { projectLiveTimeline(it) }.orEmpty() }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var draft by rememberSaveable(sessionKey.backendId, sessionKey.slotKey) { mutableStateOf("") }
    var attachments by remember(sessionKey) { mutableStateOf(emptyList<LiveImage>()) }
    // Read-only file preview: path plus loaded text (null while fetching).
    var preview by remember(sessionKey) { mutableStateOf<Pair<String, String?>?>(null) }
    var previewError by remember(sessionKey) { mutableStateOf<String?>(null) }
    var deliverAs by remember(sessionKey) { mutableStateOf<String?>(null) }
    var busy by remember(sessionKey) { mutableStateOf(false) }
    var notice by remember(sessionKey) { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    // Same limits as the WebUI; reading/compressing happens off the picker callback's
    // critical path only because these are local files, and failures keep the draft.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) {
            notice = null
            val room = (ImageAttachments.MAX_IMAGES - attachments.size).coerceAtLeast(0)
            val picked = uris.take(room).mapNotNull { uri ->
                ImageAttachments.read(context, uri).getOrElse { error -> notice = error.message ?: "无法读取图片"; null }
            }
            val merged = attachments + picked
            val problem = ImageAttachments.validate(merged)
            if (problem != null) notice = problem else attachments = merged
        }
    }
    var menu by remember { mutableStateOf(false) }
    var dialog by remember(sessionKey) { mutableStateOf<String?>(null) }
    var forkEntry by remember(sessionKey) { mutableStateOf<String?>(null) }
    var answered by remember(sessionKey) { mutableStateOf(emptySet<String>()) }
    val visibleCount = timeline.size

    // Opening/subscribing is strictly read-only. Repository owns foreground handling
    // and releasing our lease when the focused screen is disposed.
    DisposableEffect(live, sessionKey) {
        live.focus(sessionKey)
        onDispose { live.unfocus(sessionKey) }
    }

    // Follow streaming only while the reader is already near the bottom; do not
    // pull them away from reading old messages.
    LaunchedEffect(visibleCount, timeline.lastOrNull()) {
        val visible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        if (visibleCount > 0 && (visible >= visibleCount - 3 || visible < 0)) {
            listState.scrollToItem(visibleCount - 1)
        }
    }

    suspend fun ensureLease(): Result<Unit> {
        if (live.leases.value.containsKey(sessionKey)) return Result.success(Unit)
        val current = live.details.value[sessionKey]?.summary
            ?: live.sessions.value.firstOrNull { it.key == sessionKey }?.summary
        if (current?.claim?.state == "claimed") {
            return Result.failure(IllegalStateException("其他端持有控制权，请先在该端释放；不会抢占。"))
        }
        return live.claim(sessionKey)
    }

    fun perform(label: String, close: Boolean = false, operation: suspend () -> Result<Unit>) {
        if (busy) return
        busy = true; notice = null
        scope.launch {
            val result = operation()
            busy = false
            result.fold(onSuccess = {
                notice = label
                if (close) dialog = null
            }, onFailure = { notice = it.message ?: "操作失败" })
        }
    }

    fun transition(restarting: Boolean, entryId: String? = null) {
        if (busy) return
        busy = true; notice = null
        scope.launch {
            val claimed = ensureLease()
            if (claimed.isFailure) {
                notice = claimed.exceptionOrNull()?.message ?: "取得控制权失败"
                busy = false
                return@launch
            }
            val result = if (restarting) live.restart(sessionKey) else live.fork(sessionKey, entryId.orEmpty())
            busy = false
            result.fold(onSuccess = { key ->
                dialog = null; forkEntry = null
                live.refreshAll()
                if (key != null) onOpenLive(key)
                else notice = "请求已接受，等待新进程注册；请返回列表刷新，不要重复执行。"
            }, onFailure = { notice = "${it.message ?: "操作失败"}；若结果不确定，请先刷新列表确认，勿立即重试。" })
        }
    }

    fun openExternalUrl(url: String) {
        // Leaves the app for the user's browser; only plain web links are accepted.
        if (!externalUrlAllowed(url)) { notice = "不支持的链接类型"; return }
        runCatching {
            context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
        }.onFailure { notice = "无法打开链接：${it.message}" }
    }

    fun openPathPreview(path: String) {
        previewError = null
        preview = path to null
        scope.launch {
            repo.live.readFile(sessionKey.backendId, path).fold(
                onSuccess = { text -> preview = path to text },
                onFailure = { error -> preview = null; previewError = error.message ?: "无法读取文件" },
            )
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(summary?.title ?: "Live Pi", maxLines = 1, style = MaterialTheme.typography.titleMedium)
                        Text(aggregate?.backendName ?: sessionKey.backendId, style = MaterialTheme.typography.labelSmall)
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                actions = {
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "会话操作") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("刷新") }, enabled = !busy, onClick = {
                                menu = false; perform("已刷新") { live.refresh(sessionKey) }
                            })
                            listOf("title" to "修改标题", "model" to "选择模型", "thinking" to "思考等级",
                                "meta" to "置顶 / 标签", "tree" to "会话树（只读）").forEach { (id, label) ->
                                DropdownMenuItem(text = { Text(label) }, enabled = !busy, onClick = { menu = false; notice = null; dialog = id })
                            }
                            if (summary?.capabilities?.contains("context_view") == true) {
                                DropdownMenuItem(text = { Text("检查上下文（只读）") }, enabled = !busy,
                                    onClick = { menu = false; notice = null; dialog = "context" })
                            }
                            HorizontalDivider()
                            listOf("compact" to "压缩上下文…", "reload" to "重载扩展…", "restart" to "重启 Pi 进程…")
                                .forEach { (id, label) -> DropdownMenuItem(text = { Text(label) }, enabled = !busy && !heldElsewhere,
                                    onClick = { menu = false; notice = null; dialog = id }) }
                            DropdownMenuItem(text = { Text("尚未支持的 WebUI 功能") }, onClick = { menu = false; notice = null; dialog = "remaining" })
                        }
                    }
                },
            )
        },
        bottomBar = {
            Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 4.dp)) {
                SelectionContainer {
                    Column(Modifier.heightIn(max = 100.dp).verticalScroll(rememberScrollState())) {
                        notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        errors[sessionKey]?.takeIf { it != notice }?.let {
                            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (attachments.isNotEmpty()) Row(
                    Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    attachments.forEachIndexed { index, image ->
                        Box {
                            val preview = remember(image.data) {
                                runCatching {
                                    val bytes = android.util.Base64.decode(image.data, android.util.Base64.DEFAULT)
                                    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
                                }.getOrNull()
                            }
                            if (preview != null) Image(preview, "待发送图片 ${index + 1}", Modifier.size(56.dp),
                                contentScale = ContentScale.Crop)
                            else Box(Modifier.size(56.dp).background(MaterialTheme.colorScheme.surfaceVariant))
                            IconButton(onClick = { attachments = attachments - image },
                                modifier = Modifier.size(20.dp).align(Alignment.TopEnd)) {
                                Icon(Icons.Filled.Close, "移除图片 ${index + 1}", Modifier.size(14.dp))
                            }
                        }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(enabled = !busy && owned, onClick = {
                        perform("已请求中止") {
                            if (live.leases.value.containsKey(sessionKey)) live.abort(sessionKey)
                            else Result.failure(IllegalStateException("本机已不再持有控制权，未发送中止。"))
                        }
                    }) { Text("中止") }
                    Text(
                        if (owned) "本机接管中 · 仅中止/压缩需要" else "可直接输入 · 与网页、TUI 同步",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    IconButton(enabled = !busy && attachments.size < ImageAttachments.MAX_IMAGES,
                        onClick = { picker.launch("image/*") }) {
                        Icon(Icons.Filled.Add, "附加图片（最多 4 张）")
                    }
                    OutlinedTextField(value = draft, onValueChange = { draft = it }, modifier = Modifier.weight(1f),
                        placeholder = { Text("输入消息（网页、TUI 也可同时输入）…") }, maxLines = 4, enabled = !busy)
                    FilledIconButton(enabled = !busy && summary != null && (draft.isNotBlank() || attachments.isNotEmpty()) && ImageAttachments.validate(attachments) == null,
                        onClick = {
                        val text = draft
                        val images = attachments
                        perform("已发送") {
                            live.send(sessionKey, text, deliverAs, images).onSuccess {
                                // Never discard the draft or the attachment on failed/uncertain delivery.
                                if (draft == text) draft = ""
                                if (attachments == images) attachments = emptyList()
                            }
                        }
                    }) { Icon(Icons.AutoMirrored.Filled.Send, "发送") }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf(null to "默认", "steer" to "引导", "followUp" to "排队").forEach { (value, label) ->
                        FilterChip(selected = deliverAs == value, enabled = !busy, onClick = { deliverAs = value }, label = { Text(label) })
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            val backend = backendStates[sessionKey.backendId]
            if (backend?.connected != true || backend.message != null) {
                Text(backend?.message ?: if (backend?.needsPairing == true) "需要重新手机配对" else "连接中断或正在连接；下方可能是缓存内容。",
                    Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            summary?.let { s ->
                SelectionContainer {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                        Text("${s.status} · ${s.model?.let { "${it.provider}/${it.id}" } ?: "模型未知"} · ${s.thinkingLevel ?: "默认思考"}",
                            style = MaterialTheme.typography.labelSmall)
                        Text(s.cwd, style = MaterialTheme.typography.labelSmall, maxLines = 2)
                        s.contextUsage?.let { usage ->
                            Text("上下文 ${usage.tokens?.toString() ?: "?"} / ${usage.contextWindow}" +
                                (usage.percent?.let { " · ${"%.1f".format(it)}%" } ?: ""), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
            HorizontalDivider()
            if (timeline.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(if (detail == null) "等待会话详情；可从菜单刷新。" else "暂无消息（只读打开）。")
                }
            } else LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(timeline, key = { it.id }) { item ->
                    NativeTimelineCard(
                        item = item,
                        onOpenPath = ::openPathPreview,
                        onOpenUrl = ::openExternalUrl,
                        enabled = !busy && !heldElsewhere,
                        onFork = { entryId -> notice = null; forkEntry = entryId; dialog = "fork" },
                    )
                }
            }
        }
    }

    val dismiss = { if (!busy) { dialog = null; forkEntry = null } }
    when (dialog) {
        "title" -> LiveTextDialog("修改标题", summary?.sessionName.orEmpty(), "标题", busy, notice, dismiss) { value ->
            perform("标题已更新", close = true) {
                ensureLease().fold(onSuccess = { live.rename(sessionKey, value) }, onFailure = { Result.failure(it) })
            }
        }
        "meta" -> LiveMetadataDialog(aggregate?.meta, busy, notice, dismiss) { tags, pinned ->
            perform("标签 / 置顶已更新", close = true) { live.patchMeta(sessionKey, tags, pinned) }
        }
        "model", "thinking" -> LiveModelDialog(repo, sessionKey, summary, dialog == "thinking", busy, notice, dismiss,
            onModel = { option -> perform("模型已更新", close = true) {
                ensureLease().fold(onSuccess = { live.setModel(sessionKey, option.provider, option.id) }, onFailure = { Result.failure(it) })
            } },
            onThinking = { level -> perform("已请求切换思考等级", close = true) {
                ensureLease().fold(onSuccess = { live.setThinking(sessionKey, level) }, onFailure = { Result.failure(it) })
            } },
        )
        "context", "tree" -> LiveInspectionDialog(repo, sessionKey, dialog == "context", dismiss)
        "compact", "reload", "restart", "fork" -> {
            val action = dialog
            val label = when (action) { "compact" -> "压缩上下文"; "reload" -> "重载扩展"; "restart" -> "重启 Pi 进程"; else -> "从此用户消息分叉" }
            val realFork = forkEntry?.takeIf { id -> timeline.any { it.role == "user" && it.forkable && it.entryId == id } }
            AlertDialog(onDismissRequest = { dismiss() }, title = { Text("确认$label？") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (action == "fork") "将从真实用户条目 ${realFork ?: "（条目已不可用）"} 创建分支。" else "这会修改正在运行的 Pi 会话。")
                        Text("执行时将尝试取得控制权，不会抢占其他端。不会自动重试；服务器不支持或拒绝时会显示原始错误。")
                        notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                },
                confirmButton = { TextButton(enabled = !busy && !heldElsewhere && (action != "fork" || realFork != null), onClick = {
                    when (action) {
                        "fork" -> transition(false, realFork)
                        "restart" -> transition(true)
                        else -> perform("已请求$label", close = true) {
                            ensureLease().fold(onSuccess = {
                                if (action == "compact") live.compact(sessionKey) else live.reload(sessionKey)
                            }, onFailure = { Result.failure(it) })
                        }
                    }
                }) { Text("确认执行") } },
                dismissButton = { TextButton(enabled = !busy, onClick = { dismiss() }) { Text("取消") } },
            )
        }
        "remaining" -> AlertDialog(onDismissRequest = { dismiss() }, title = { Text("原生 Live Pi 范围") },
            text = { Text("已支持实时对话与会话控制。文件浏览/上传、PTY 终端、完整工作流图谱和复杂编辑仍请使用 WebUI；此处不宣称完整功能对齐。") },
            confirmButton = { TextButton(onClick = { dismiss() }) { Text("知道了") } })
    }

    previewError?.let { message ->
        AlertDialog(onDismissRequest = { previewError = null }, title = { Text("预览失败") },
            text = { Text(message) }, confirmButton = { TextButton(onClick = { previewError = null }) { Text("知道了") } })
    }
    preview?.let { (path, content) ->
        Dialog(onDismissRequest = { preview = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize().padding(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SelectionContainer { Text(path, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, maxLines = 2) }
                        TextButton(onClick = { preview = null }) { Text("关闭") }
                    }
                    HorizontalDivider()
                    if (content == null) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { Text("读取中…") }
                    else if (path.endsWith(".md", true) || path.endsWith(".markdown", true)) {
                        SelectionContainer {
                            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                                MarkdownBody(content, onOpenPath = ::openPathPreview, onOpenUrl = ::openExternalUrl)
                            }
                        }
                    } else {
                        // Plain files are shown verbatim: monospace, no markdown guessing.
                        SelectionContainer {
                            Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                                Text(
                                    content.ifBlank { "（空文件）" },
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    detail?.pendingUi?.firstOrNull { it.id !in answered }?.let { request ->
        // Only an explicit answer invokes the repository; never auto-answer prompts.
        LiveExtensionDialog(request = request, onAnswer = { value, cancelled ->
            live.answer(sessionKey, request, value, cancelled).onSuccess { answered = answered + request.id }
        })
    }
}

@Composable
internal fun LiveTimelineCard(item: LiveTimelineItem, enabled: Boolean, onFork: (String) -> Unit) {
    val tool = item.toolName != null || item.role == "tool" || item.role == "toolResult"
    var showThinking by remember(item.id) { mutableStateOf(false) }
    val background = when {
        item.isError -> MaterialTheme.colorScheme.errorContainer
        item.role == "user" -> MaterialTheme.colorScheme.primaryContainer
        tool -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.secondaryContainer
    }
    Column(Modifier.fillMaxWidth().background(background, MaterialTheme.shapes.medium).padding(12.dp)) {
        Text("${item.role}${item.toolName?.let { " · $it" } ?: ""}${if (item.isError) " · 错误" else ""}", style = MaterialTheme.typography.labelSmall)
        item.thinking?.takeIf { it.isNotBlank() }?.let { thinking ->
            TextButton(onClick = { showThinking = !showThinking }) { Text(if (showThinking) "收起思考" else "查看思考") }
            if (showThinking) SelectionContainer { Text(thinking, style = MaterialTheme.typography.bodySmall) }
        }
        SelectionContainer {
            Text(item.text.ifBlank { if (item.thinking.isNullOrBlank()) "（等待内容…）" else "（思考中）" },
                style = if (tool) MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyMedium)
        }
        if (item.role == "user" && item.forkable && !item.entryId.isNullOrBlank()) {
            TextButton(enabled = enabled, onClick = { onFork(item.entryId) }) { Text("从此消息分叉…") }
        }
    }
}
