package com.sam.pidash.ui.backends

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ModelDefinition
import com.sam.pidash.domain.model.ModelProvider
import com.sam.pidash.domain.model.ModelProviderRequest
import com.sam.pidash.ui.common.CompactPageHeader
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.common.PrimaryCreateAction
import com.sam.pidash.ui.common.SectionLabel
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ModelProvidersScreen(
    repo: PiDashRepository,
    backends: List<Backend>,
    initialBackendId: String,
    onBack: () -> Unit,
) {
    var backendId by remember { mutableStateOf(backends.firstOrNull { it.id == initialBackendId }?.id ?: backends.firstOrNull()?.id.orEmpty()) }
    var providers by remember(backendId) { mutableStateOf<List<ModelProvider>?>(null) }
    var loading by remember(backendId) { mutableStateOf(true) }
    var error by remember(backendId) { mutableStateOf<String?>(null) }
    var revision by remember(backendId) { mutableIntStateOf(0) }
    var editing by remember { mutableStateOf<ModelProvider?>(null) }
    var presetOpen by remember { mutableStateOf(false) }
    var backendMenu by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val backend = backends.firstOrNull { it.id == backendId }

    LaunchedEffect(backendId, revision) {
        if (backendId.isBlank()) { error = "没有已配置的服务器"; loading = false; return@LaunchedEffect }
        loading = true
        error = null
        repo.live.modelProviders(backendId).fold(
            onSuccess = { providers = it },
            onFailure = { error = it.message ?: "无法读取模型配置" },
        )
        loading = false
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            CompactPageHeader(
                title = "模型与服务商",
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", modifier = Modifier.size(20.dp))
                    }
                },
                actions = {},
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        floatingActionButton = {
            PrimaryCreateAction("添加服务商") { presetOpen = true }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = Spacing.md),
            contentPadding = PaddingValues(top = Spacing.sm, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (backends.size > 1) {
                item {
                    Box {
                        OutlinedButton(onClick = { backendMenu = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                            Text("服务器：${backend?.name ?: backendId}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        DropdownMenu(expanded = backendMenu, onDismissRequest = { backendMenu = false }) {
                            backends.forEach { candidate ->
                                DropdownMenuItem(
                                    text = { Text(candidate.name, maxLines = 1) },
                                    onClick = { backendId = candidate.id; backendMenu = false; editing = null },
                                )
                            }
                        }
                    }
                }
            }
            item {
                Text(
                    "这里修改 Dashboard 主机上的 pi models.json。API Key 只写入服务器，不在 App 保存或显示；保存后需要新建或重启 Pi 会话，运行中的会话不会自动换模型。订阅登录由 pi 自身管理，本页只显示状态。",
                    style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            error?.let {
                item {
                    GroupedCard {
                        Column(Modifier.padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            Text("读取模型配置失败：$it", style = PiType.footnote, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { revision++ }) { Text("重新加载") }
                        }
                    }
                }
            }
            val current = providers
            if (current != null && current.isEmpty()) item {
                GroupedCard {
                    Column(Modifier.padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                        Text("还没有可编辑的服务商", style = PiType.callout)
                        Text("点右下角添加，可先选 OpenAI、Anthropic、DashScope 等预设，再填 API Key 和自定义模型。", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (current != null) items(current, key = { it.id }) { provider ->
                ProviderRow(provider) { editing = provider }
            }
            if (current != null) item {
                Text(
                    "保存后新模型会加入当前允许列表；如果模型仍未出现在选择器，请重启对应 Pi 会话或先检查 provider 配置。",
                    style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = Spacing.sm),
                )
            }
        }
    }

    if (presetOpen) {
        ModalBottomSheet(onDismissRequest = { presetOpen = false }, shape = Radii.sheet) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 620.dp)
                    .verticalScroll(rememberScrollState()).padding(bottom = Spacing.lg),
            ) {
                Text("添加服务商", style = PiType.pageTitle, modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm))
                Text("先选预设，再改 Base URL、API Key 和模型；自定义也可用。", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs))
                modelProviderPresets.forEach { preset ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable {
                            presetOpen = false
                            val existing = providers?.firstOrNull { it.id == preset.id }
                            editing = existing?.copy(
                                // Auth-only providers have no models.json API/base yet;
                                // the preset supplies the adapter fields for adding models.
                                api = existing.api.ifBlank { preset.api },
                                baseUrl = existing.baseUrl.ifBlank { preset.baseUrl },
                            ) ?: ModelProvider(id = preset.id, api = preset.api, baseUrl = preset.baseUrl)
                        }.padding(horizontal = Spacing.lg, vertical = Spacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(preset.label, style = PiType.callout)
                            Text(preset.id, style = PiType.monoMicro, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(if (providers?.any { it.id == preset.id } == true) "编辑" else "添加", style = PiType.caption, color = MaterialTheme.colorScheme.primary)
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
                }
            }
        }
    }

    editing?.let { provider ->
        ModelProviderEditorSheet(
            repo = repo,
            backendId = backendId,
            initial = provider,
            existing = providers?.firstOrNull { it.id == provider.id },
            onDismiss = { editing = null },
            onSaved = { message ->
                editing = null
                scope.launch { snackbar.showSnackbar(message) }
                revision++
            },
        )
    }
}

@Composable
private fun ProviderRow(provider: ModelProvider, onEdit: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    GroupedCard {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onEdit).padding(horizontal = Spacing.lg, vertical = Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Text(provider.id, style = PiType.callout.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (provider.piAuth) Text("订阅/pi 登录", style = PiType.micro, color = scheme.primary)
                }
                Text(
                    provider.baseUrl.ifBlank { "由 pi 内置 provider 提供" },
                    style = PiType.monoMicro,
                    color = scheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                MetaText(
                    "${provider.models.size} 个模型 · " +
                        when {
                            !provider.hasKey -> "未配置 Key"
                            provider.keySource == "pi-oauth" -> "订阅登录"
                            provider.keySource == "pi-auth" -> "pi 已登录"
                            provider.keySource == "env" -> "环境变量 Key"
                            else -> "Key 已保存"
                        },
                )
            }
            Icon(Icons.Filled.Edit, contentDescription = "编辑 ${provider.id}", tint = scheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelProviderEditorSheet(
    repo: PiDashRepository,
    backendId: String,
    initial: ModelProvider,
    existing: ModelProvider?,
    onDismiss: () -> Unit,
    onSaved: (String) -> Unit,
) {
    val isNew = existing == null
    var providerId by remember(initial.id) { mutableStateOf(initial.id) }
    var api by remember(initial.id) { mutableStateOf(initial.api.ifBlank { "openai-completions" }) }
    var baseUrl by remember(initial.id) { mutableStateOf(initial.baseUrl) }
    var apiKey by remember(initial.id) { mutableStateOf("") }
    var models by remember(initial.id) { mutableStateOf(initial.models) }
    var apiMenu by remember { mutableStateOf(false) }
    var modelBeingEdited by remember { mutableStateOf<ModelDefinition?>(null) }
    var addModel by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val keyManagedByPi = initial.piAuth && initial.keySource == "pi-oauth"
    val apiLabel = modelApiOptions.firstOrNull { it.first == api }?.second ?: api

    fun save() {
        localError = null
        if (!providerId.matches(Regex("[a-z0-9][a-z0-9._-]{0,63}"))) {
            localError = "服务商标识只能含小写字母、数字、点、下划线和连字符"
            return
        }
        if (baseUrl.isBlank()) { localError = "请填写 Base URL"; return }
        if (models.any { it.id.isBlank() }) { localError = "模型 ID 不能为空"; return }
        saving = true
        scope.launch {
            repo.live.saveModelProvider(
                backendId,
                providerId,
                ModelProviderRequest(
                    api = api,
                    baseUrl = baseUrl.trim(),
                    apiKey = apiKey.trim().takeIf { it.isNotEmpty() },
                    models = models,
                ),
            ).fold(
                onSuccess = {
                    saving = false
                    onSaved("已保存 ${providerId}；重启或新建 Pi 会话后生效")
                },
                onFailure = {
                    saving = false
                    localError = it.message ?: "保存失败"
                },
            )
        }
    }

    ModalBottomSheet(onDismissRequest = { if (!saving) onDismiss() }, shape = Radii.sheet) {
        Column(Modifier.fillMaxWidth().heightIn(max = 720.dp).verticalScroll(rememberScrollState()).padding(bottom = Spacing.lg)) {
            Text(
                if (isNew) "添加服务商" else "编辑 ${initial.id}",
                style = PiType.pageTitle,
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
            )
            Text(
                if (isNew) "凭据写入 Dashboard 主机的 pi models.json，不会在手机保存或回显。" else "API Key 留空会保留服务器上已有的 Key；订阅/pi 登录状态不会被这里覆盖。",
                style = PiType.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
            )
            PiTextField(
                value = providerId,
                onValueChange = { providerId = it.trim() },
                enabled = isNew,
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
                label = "服务商标识",
                placeholder = "例如 openai、my-gateway",
                supportingText = "用于 provider/model 名称；保存后不在此页改名",
            )
            Box(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs)) {
                OutlinedButton(onClick = { apiMenu = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(apiLabel, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Filled.MoreVert, contentDescription = null, modifier = Modifier.size(18.dp))
                }
                DropdownMenu(expanded = apiMenu, onDismissRequest = { apiMenu = false }) {
                    modelApiOptions.forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(label) }, onClick = { api = value; apiMenu = false })
                    }
                }
            }
            PiTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it.trim() },
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
                label = "Base URL",
                placeholder = "https://api.example.com/v1",
            )
            PiTextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                enabled = !keyManagedByPi,
                isPassword = true,
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
                label = "API Key",
                placeholder = if (keyManagedByPi) "订阅登录由 pi 管理" else if (initial.hasKey) "已保存；留空保持不变" else "粘贴 API Key",
                supportingText = when {
                    keyManagedByPi -> "当前是 pi 订阅登录；不要用 API Key 覆盖。"
                    initial.hasKey -> "服务器已有 Key（${initial.keySource}）；只有输入新值才会替换。"
                    else -> "保存后不会回显；只通过 HTTPS 发送到 Dashboard。"
                },
            )
            HorizontalDivider(Modifier.padding(vertical = Spacing.sm), color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("模型", style = PiType.callout.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f))
                TextButton(onClick = { modelBeingEdited = null; addModel = true }) { Text("添加模型") }
            }
            if (models.isEmpty()) {
                Text("还没有模型；添加后才会出现在 Pi 模型选择器。", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs))
            }
            models.forEachIndexed { index, model ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { modelBeingEdited = model }.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(model.id, style = PiType.monoMicro, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            buildString {
                                if (model.name?.isNotBlank() == true) append(model.name).append(" · ")
                                append("context ${model.contextWindow.ifPositiveOrDash()}")
                                append(" · max ${model.maxTokens.ifPositiveOrDash()}")
                                if (model.reasoning) append(" · thinking")
                                if ("image" in model.input) append(" · 图片")
                            },
                            style = PiType.caption,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    IconButton(onClick = { models = models.filterIndexed { i, _ -> i != index } }, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Filled.Delete, contentDescription = "删除模型 ${model.id}", modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
            }
            localError?.let { Text(it, style = PiType.footnote, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm)) }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.sm),
                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                TextButton(enabled = !saving, onClick = onDismiss, modifier = Modifier.weight(1f)) { Text("取消") }
                Button(enabled = !saving, onClick = ::save, modifier = Modifier.weight(1f)) {
                    if (saving) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("保存")
                }
            }
        }
    }

    if (addModel || modelBeingEdited != null) {
        ModelEditorDialog(
            initial = modelBeingEdited,
            onDismiss = { addModel = false; modelBeingEdited = null },
            onSave = { model ->
                val replacing = modelBeingEdited
                models = if (replacing == null) {
                    models.filterNot { it.id == model.id } + model
                } else {
                    models.map { if (it.id == replacing.id) model else it }
                }
                addModel = false
                modelBeingEdited = null
            },
        )
    }
}

@Composable
private fun ModelEditorDialog(
    initial: ModelDefinition?,
    onDismiss: () -> Unit,
    onSave: (ModelDefinition) -> Unit,
) {
    var id by remember(initial) { mutableStateOf(initial?.id.orEmpty()) }
    var name by remember(initial) { mutableStateOf(initial?.name.orEmpty()) }
    var context by remember(initial) { mutableStateOf(initial?.contextWindow?.takeIf { it > 0 }?.toString().orEmpty()) }
    var maxTokens by remember(initial) { mutableStateOf(initial?.maxTokens?.takeIf { it > 0 }?.toString().orEmpty()) }
    var reasoning by remember(initial) { mutableStateOf(initial?.reasoning == true) }
    var image by remember(initial) { mutableStateOf("image" in initial?.input.orEmpty()) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        shape = Radii.sheet,
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "添加模型" else "编辑模型", style = PiType.pageTitle) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                PiTextField(id, { id = it.trim() }, label = "模型 ID", placeholder = "例如 gpt-4.1 或 vendor/model", singleLine = true)
                PiTextField(name, { name = it }, label = "显示名称（可选）", singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    PiTextField(context, { context = it.filter(Char::isDigit) }, label = "上下文窗口", modifier = Modifier.weight(1f), singleLine = true)
                    PiTextField(maxTokens, { maxTokens = it.filter(Char::isDigit) }, label = "最大输出", modifier = Modifier.weight(1f), singleLine = true)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("支持思考", style = PiType.callout, modifier = Modifier.weight(1f))
                    Switch(checked = reasoning, onCheckedChange = { reasoning = it })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("支持图片输入", style = PiType.callout, modifier = Modifier.weight(1f))
                    Switch(checked = image, onCheckedChange = { image = it })
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = PiType.footnote) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (!id.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}"))) {
                    error = "模型 ID 不能为空，且不能包含空格"
                } else {
                    onSave(
                        ModelDefinition(
                            id = id,
                            name = name.trim().takeIf { it.isNotEmpty() },
                            contextWindow = context.toLongOrNull() ?: 0,
                            maxTokens = maxTokens.toLongOrNull() ?: 0,
                            reasoning = reasoning,
                            input = buildList { add("text"); if (image) add("image") },
                        ),
                    )
                }
            }) { Text("保存模型") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

private fun Long.ifPositiveOrDash(): String = if (this > 0) toString() else "—"
