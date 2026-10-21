package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.LiveMeta
import com.sam.pidash.domain.model.LiveModelOption
import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private val inspectionJson = Json { prettyPrint = true }

@Composable
internal fun LiveTextDialog(
    title: String,
    initial: String,
    label: String,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSubmit: (String) -> Unit,
) {
    var value by remember { mutableStateOf(initial) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = value, onValueChange = { value = it }, label = { Text(label) }, enabled = !busy)
            Text("保存时尝试取得控制权，不会抢占其他端。", style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }, confirmButton = { TextButton(enabled = !busy && value.isNotBlank(), onClick = { onSubmit(value.trim()) }) { Text("保存") } },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") } })
}

@Composable
internal fun LiveMetadataDialog(
    meta: LiveMeta?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSubmit: (List<String>, Boolean) -> Unit,
) {
    var tags by remember { mutableStateOf(meta?.tags.orEmpty().joinToString(", ")) }
    var pinned by remember { mutableStateOf(meta?.pinned == true) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("置顶 / 标签") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row {
                Checkbox(checked = pinned, enabled = !busy, onCheckedChange = { pinned = it })
                Text("置顶", Modifier.padding(top = 12.dp))
            }
            OutlinedTextField(value = tags, onValueChange = { tags = it }, enabled = !busy, label = { Text("标签，用逗号分隔") })
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = {
        onSubmit(tags.split(',', '，').map { it.trim() }.filter { it.isNotEmpty() }.distinct(), pinned)
    }) { Text("保存") } }, dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("取消") } })
}

@Composable
internal fun LiveModelDialog(
    repo: PiDashRepository,
    key: SessionKey,
    summary: LiveSummary?,
    thinking: Boolean,
    busy: Boolean,
    operationError: String?,
    onDismiss: () -> Unit,
    onModel: (LiveModelOption) -> Unit,
    onThinking: (String) -> Unit,
) {
    var options by remember(key) { mutableStateOf(emptyList<LiveModelOption>()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var level by remember { mutableStateOf(summary?.thinkingLevel.orEmpty()) }
    var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(key, revision) {
        loading = true; error = null
        repo.live.models(key).fold(onSuccess = { options = it }, onFailure = { error = it.message ?: "模型列表加载失败" })
        loading = false
    }
    val current = options.firstOrNull { it.provider == summary?.model?.provider && it.id == summary?.model?.id }
    val levels = current?.thinkingLevels.orEmpty()
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, title = { Text(if (thinking) "思考等级" else "可用模型") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("当前：${summary?.model?.let { "${it.provider}/${it.id}" } ?: "未知"} · ${summary?.thinkingLevel ?: "默认"}",
                    style = MaterialTheme.typography.bodySmall)
                Text("选择后尝试取得控制权，不会抢占其他端。", style = MaterialTheme.typography.bodySmall)
                if (loading || busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error)
                    TextButton(enabled = !busy && !loading, onClick = { revision++ }) { Text("重新加载选项") }
                }
                operationError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (thinking) {
                    if (!loading && levels.isEmpty()) Text("服务器未提供当前模型的思考等级选项；可手动填写，是否支持由服务器验证。")
                    levels.distinct().forEach { option ->
                        FilterChip(selected = level == option, enabled = !busy, onClick = { level = option }, label = { Text(option) })
                    }
                    OutlinedTextField(value = level, onValueChange = { level = it }, enabled = !busy,
                        singleLine = true, label = { Text("思考等级") })
                } else {
                    OutlinedTextField(value = query, onValueChange = { query = it }, label = { Text("搜索模型") }, singleLine = true)
                    if (!loading && error == null && options.isEmpty()) Text("服务器没有返回可用模型。")
                    options.filter { "${it.provider}/${it.id} ${it.name}".contains(query, ignoreCase = true) }.forEach { option ->
                        OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { onModel(option) }) {
                            Column(Modifier.fillMaxWidth()) {
                                Text(option.name.ifBlank { option.id })
                                Text("${option.provider}/${option.id}", style = MaterialTheme.typography.labelSmall)
                                if (option.contextWindow > 0) Text("上下文 ${option.contextWindow}", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (thinking) TextButton(enabled = !busy && level.isNotBlank(), onClick = { onThinking(level.trim()) }) { Text("设置") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("关闭") } },
    )
}

@Composable
internal fun LiveInspectionDialog(repo: PiDashRepository, key: SessionKey, context: Boolean, onDismiss: () -> Unit) {
    var content by remember(key, context) { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(key, context, revision) {
        loading = true; error = null
        val result = if (context) repo.live.context(key) else repo.live.tree(key)
        result.fold(onSuccess = {
            val formatted = inspectionJson.encodeToString(JsonElement.serializer(), it)
            content = if (formatted.length > 65_536) formatted.take(65_536) + "\n\n（预览已截断；完整内容请使用 WebUI）" else formatted
        },
            onFailure = { error = it.message ?: "加载失败" })
        loading = false
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(if (context) "上下文（只读）" else "会话树（只读）") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                content?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)) } }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
        dismissButton = { TextButton(enabled = !loading, onClick = { revision++ }) { Text("刷新") } },
    )
}

@Composable
internal fun LiveExtensionDialog(request: LiveUiRequest, onAnswer: suspend (String?, Boolean) -> Result<Unit>) {
    var value by remember(request.id) { mutableStateOf(request.prefill.orEmpty()) }
    var busy by remember(request.id) { mutableStateOf(false) }
    var error by remember(request.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun respond(answer: String?, cancelled: Boolean = false) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            onAnswer(answer, cancelled).onFailure { error = it.message ?: "回答失败；请求也可能已在其他端完成。" }
            busy = false
        }
    }
    val supported = request.method in listOf("confirm", "select", "input", "editor")
    AlertDialog(
        onDismissRequest = {},
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
        title = { Text(request.title.ifBlank { "扩展请求" }) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("请明确回答或取消；若其他端先回答，此请求会自动消失。", style = MaterialTheme.typography.bodySmall)
                request.message?.let { SelectionContainer { Text(it) } }
                when (request.method) {
                    "confirm" -> Text("是否允许本次操作？")
                    "select" -> request.options.forEach { option ->
                        OutlinedButton(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = { respond(option) }) { Text(option) }
                    }
                    "input", "editor" -> OutlinedTextField(value = value, onValueChange = { value = it }, enabled = !busy,
                        modifier = Modifier.fillMaxWidth(), placeholder = { Text(request.placeholder.orEmpty()) },
                        singleLine = request.method == "input", minLines = if (request.method == "editor") 5 else 1,
                        maxLines = if (request.method == "editor") 12 else 1)
                    else -> Text("原生 UI 不支持此请求类型：${request.method}。可明确取消或在 WebUI / TUI 中处理。")
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            if (supported && request.method != "select") TextButton(enabled = !busy, onClick = {
                respond(if (request.method == "confirm") "true" else value)
            }) { Text(if (request.method == "confirm") "允许这次操作" else "提交") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = { respond(null, true) }) { Text("明确取消") } },
    )
}
