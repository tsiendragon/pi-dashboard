package com.sam.pidash.ui.live

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.LiveMeta
import com.sam.pidash.domain.model.LiveModelOption
import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.theme.PiType
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private val inspectionJson = Json { prettyPrint = true }

internal val SESSION_COLOR_PRESETS = listOf(
    "" to "默认",
    "#5287be" to "蓝",
    "#54937d" to "绿",
    "#9571c4" to "紫",
    "#c67598" to "粉",
    "#c97864" to "橙",
    "#b58a35" to "金",
    "#c65b5b" to "红",
    "#358e91" to "青",
    "#898b95" to "灰",
)

internal val SESSION_EMOJI_PRESETS = linkedMapOf(
    "常用" to listOf("🚀", "⚡", "🔥", "✨", "🎯", "🛠️", "📦", "🧪", "🤖", "💡", "📌", "🔍", "✅", "📝"),
    "科技" to listOf("💻", "🖥️", "📱", "⌨️", "🔌", "📡", "🛰️", "🧬", "⚙️", "🔧", "🔨", "🛡️", "🔒", "🔑"),
    "情绪" to listOf("😀", "😎", "🤔", "🧐", "🥳", "💪", "👍", "👏", "🙌", "👀", "❤️", "⭐", "🌟", "🎉"),
    "动物" to listOf("🐱", "🐶", "🐼", "🦊", "🦁", "🐸", "🐙", "🐳", "🦄", "🐝", "🦋", "🐢", "🦉", "🦖"),
    "符号" to listOf("🟢", "🔵", "🟣", "🟠", "🔴", "🟡", "⚪", "💎", "🏆", "🚩", "🔔", "⏳", "♻️", "♾️"),
)

internal data class ThinkingLadderMeta(
    val id: String,
    val title: String,
    val description: String,
    val bars: Int,
    val badge: String? = null,
)

internal val THINKING_LADDER_LEVELS = listOf(
    ThinkingLadderMeta("off", "关 · Off", "不生成思考过程，极速直接回答", 0),
    ThinkingLadderMeta("minimal", "极低 · Minimal", "快速验证与格式修正，开销极小", 1),
    ThinkingLadderMeta("low", "低 · Low", "轻量逻辑检查、小型单文件编码", 2),
    ThinkingLadderMeta("medium", "中 · Medium", "平衡深度推演与响应速度，适合多数任务", 3, "推荐"),
    ThinkingLadderMeta("high", "高 · High", "多轮逻辑推导、疑难排查与算法推演", 4),
    ThinkingLadderMeta("xhigh", "特高 · Extra High", "极限思维链推演，适合复杂重构", 5),
    ThinkingLadderMeta("max", "最高 · Max", "最大推理深度，适合高难度架构诊断", 5),
)

internal fun parseHexColor(raw: String?): Color? {
    val clean = raw?.trim()?.removePrefix("#").orEmpty()
    if (!clean.matches(Regex("[0-9a-fA-F]{6}"))) return null
    return runCatching { Color(clean.toLong(16) or 0xFF000000L) }.getOrNull()
}

internal fun formatContextTokens(tokens: Long): String = when {
    tokens <= 0L -> ""
    tokens >= 1_000_000L -> "${(tokens / 100_000L) / 10.0}M".removeSuffix(".0M") + if ((tokens / 100_000L) % 10L == 0L) "M" else ""
    tokens >= 1_000L -> "${tokens / 1_000L}K"
    else -> tokens.toString()
}

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
    initialTitle: String? = null,
    onSubmit: (List<String>, Boolean, String, String, String?) -> Unit,
) {
    var title by remember(initialTitle) { mutableStateOf(initialTitle.orEmpty()) }
    var tags by remember { mutableStateOf(meta?.tags.orEmpty().joinToString(", ")) }
    var pinned by remember { mutableStateOf(meta?.pinned == true) }
    var emoji by remember { mutableStateOf(meta?.emoji.orEmpty()) }
    var color by remember { mutableStateOf(meta?.color.orEmpty()) }
    var category by remember { mutableStateOf(SESSION_EMOJI_PRESETS.keys.first()) }
    val accentColor = parseHexColor(color) ?: MaterialTheme.colorScheme.primary

    AlertDialog(onDismissRequest = onDismiss, title = { Text("设置会话装扮与名称") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                Modifier.fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))
                    .border(1.dp, accentColor.copy(alpha = 0.5f), RoundedCornerShape(12.dp))
                    .padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier.size(46.dp)
                        .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
                        .border(2.dp, accentColor, RoundedCornerShape(12.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(emoji.ifBlank { "💬" }, style = MaterialTheme.typography.titleLarge)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (initialTitle != null) {
                        OutlinedTextField(
                            value = title,
                            onValueChange = { if (it.length <= 120) title = it },
                            enabled = !busy,
                            singleLine = true,
                            label = { Text("会话名称") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Text("会话预览", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            Text("标记颜色", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SESSION_COLOR_PRESETS.forEach { (hex, label) ->
                    val dotColor = parseHexColor(hex)
                    val selected = color.equals(hex, ignoreCase = true)
                    Box(
                        Modifier.size(30.dp)
                            .clip(CircleShape)
                            .background(dotColor ?: MaterialTheme.colorScheme.surfaceVariant)
                            .border(if (selected) 2.5.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, CircleShape)
                            .clickable(enabled = !busy) { color = hex },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (hex.isEmpty()) Text("∅", style = MaterialTheme.typography.labelSmall)
                        else if (selected) Text("✓", color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                    }
                }
            }

            Text("选择表情符号", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SESSION_EMOJI_PRESETS.keys.forEach { tab ->
                    FilterChip(selected = category == tab, enabled = !busy, onClick = { category = tab }, label = { Text(tab) })
                }
            }
            val symbols = listOf("") + SESSION_EMOJI_PRESETS[category].orEmpty()
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                symbols.chunked(5).forEach { rowSymbols ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        rowSymbols.forEach { symbol ->
                            val selected = emoji == symbol
                            Surface(
                                onClick = { emoji = symbol },
                                enabled = !busy,
                                modifier = Modifier.weight(1f).height(40.dp),
                                shape = RoundedCornerShape(8.dp),
                                color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                                border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline.copy(alpha = 0.4f)),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Text(symbol.ifEmpty { "∅" }, style = MaterialTheme.typography.bodyLarge)
                                }
                            }
                        }
                        repeat(5 - rowSymbols.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }

            OutlinedTextField(
                value = emoji,
                onValueChange = { if (it.length <= 24 && it.none { ch -> ch.isISOControl() }) emoji = it },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("自定义表情（可输入或粘贴，留空清除）") },
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = pinned, enabled = !busy, onCheckedChange = { pinned = it })
                Text("📌 置顶此会话", Modifier.clickable(enabled = !busy) { pinned = !pinned })
            }
            OutlinedTextField(value = tags, onValueChange = { tags = it }, enabled = !busy, modifier = Modifier.fillMaxWidth(), singleLine = true, label = { Text("标签（逗号分隔）") })
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }, confirmButton = { TextButton(enabled = !busy && (initialTitle == null || title.isNotBlank()), onClick = {
        val nextTitle = title.trim().takeIf { initialTitle != null && it.isNotEmpty() && it != initialTitle }
        onSubmit(
            tags.split(',', '，').map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
            pinned,
            emoji.trim(),
            color.trim(),
            nextTitle,
        )
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
    var modelFilter by remember { mutableStateOf("all") }
    var level by remember { mutableStateOf(summary?.thinkingLevel.orEmpty()) }
    var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(key, revision) {
        loading = true; error = null
        repo.live.models(key).fold(onSuccess = { options = it }, onFailure = { error = it.message ?: "模型列表加载失败" })
        loading = false
    }
    val current = options.firstOrNull { it.provider == summary?.model?.provider && it.id == summary?.model?.id }
    val levels = current?.thinkingLevels.orEmpty()
    val visibleLevels = remember(levels) {
        val allowed = levels.map { it.lowercase() }.toSet()
        if (allowed.isEmpty()) THINKING_LADDER_LEVELS
        else THINKING_LADDER_LEVELS.filter { it.id in allowed }.ifEmpty { THINKING_LADDER_LEVELS }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, containerColor = MaterialTheme.colorScheme.surface,
        title = { Text(if (thinking) "思考强度" else "选择模型", style = PiType.headline) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            "当前模型：${summary?.model?.let { "${it.provider}/${it.id}" } ?: "默认"}",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            "当前思考强度：${summary?.thinkingLevel?.takeIf { it.isNotBlank() } ?: "未知"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (loading || busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error)
                    TextButton(enabled = !busy && !loading, onClick = { revision++ }) { Text("重新加载选项") }
                }
                operationError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (thinking) {
                    if (levels.isEmpty()) Text("当前模型未返回支持的档位，请以实际模型支持情况为准。", style = MaterialTheme.typography.bodySmall)
                    Column(Modifier.selectableGroup()) {
                        visibleLevels.forEach { item ->
                            val selected = level.equals(item.id, ignoreCase = true)
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.09f) else Color.Transparent)
                                    .selectable(selected = selected, enabled = !busy, role = Role.RadioButton) { level = item.id }
                                    .padding(horizontal = 12.dp, vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Row(Modifier.width(24.dp).height(18.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                    for (bar in 1..5) Box(
                                        Modifier.width(3.dp).height((3 + bar * 3).dp)
                                            .background(if (bar <= item.bars) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline.copy(alpha = 0.3f), RoundedCornerShape(2.dp)),
                                    )
                                }
                                Text(item.title, modifier = Modifier.weight(1f), style = PiType.subhead.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal), color = MaterialTheme.colorScheme.onSurface)
                                RadioButton(selected = selected, onClick = null, enabled = !busy, modifier = Modifier.size(24.dp))
                            }
                        }
                    }
                } else {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("🔍 搜索模型名称、ID 或服务商…") },
                        singleLine = true,
                    )
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(
                            "all" to "全部 (${options.size})",
                            "thinking" to "🧠 支持思考",
                            "large" to "📦 200K+ 上下文",
                        ).forEach { (id, label) ->
                            FilterChip(selected = modelFilter == id, onClick = { modelFilter = id }, label = { Text(label) })
                        }
                    }
                    val filtered = options.filter { option ->
                        val matchesQuery = query.isBlank() || "${option.provider}/${option.id} ${option.name}".contains(query, ignoreCase = true)
                        val hasThinking = option.reasoning || option.thinkingLevels.any { it != "off" }
                        val matchesFilter = when (modelFilter) {
                            "thinking" -> hasThinking
                            "large" -> option.contextWindow >= 200_000L
                            else -> true
                        }
                        matchesQuery && matchesFilter
                    }
                    if (!loading && error == null && options.isEmpty()) Text("服务器没有返回可用模型。")
                    if (!loading && options.isNotEmpty() && filtered.isEmpty()) Text("没有匹配的模型，请尝试切换筛选或关键词。")
                    filtered.groupBy { it.provider }.toSortedMap().forEach { (provider, models) ->
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)),
                        ) {
                            Column(Modifier.fillMaxWidth()) {
                                Row(
                                    Modifier.fillMaxWidth()
                                        .background(MaterialTheme.colorScheme.surfaceVariant)
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(provider, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                                    Surface(
                                        color = MaterialTheme.colorScheme.surface,
                                        shape = RoundedCornerShape(99.dp),
                                    ) {
                                        Text(
                                            "${models.size} 个模型",
                                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                                models.forEachIndexed { idx, option ->
                                    if (idx > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))
                                    val selected = option.provider == summary?.model?.provider && option.id == summary.model.id
                                    val nonOffLevels = option.thinkingLevels.filter { it != "off" }
                                    val ctxLabel = formatContextTokens(option.contextWindow)
                                    Row(
                                        Modifier.fillMaxWidth()
                                            .clickable(enabled = !busy) { onModel(option) }
                                            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f) else Color.Transparent)
                                            .padding(horizontal = 12.dp, vertical = 10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                                Text(
                                                    option.name.ifBlank { option.id },
                                                    style = MaterialTheme.typography.bodyMedium,
                                                    fontWeight = FontWeight.SemiBold,
                                                    maxLines = 1,
                                                    overflow = TextOverflow.Ellipsis,
                                                )
                                                if (selected) {
                                                    Surface(
                                                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.16f),
                                                        shape = RoundedCornerShape(4.dp),
                                                    ) {
                                                        Text(
                                                            "当前",
                                                            modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                                                            style = MaterialTheme.typography.labelSmall,
                                                            color = MaterialTheme.colorScheme.primary,
                                                            fontWeight = FontWeight.Bold,
                                                        )
                                                    }
                                                }
                                            }
                                            Text(
                                                "${option.provider}/${option.id}",
                                                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            if (nonOffLevels.isNotEmpty() || option.reasoning || ctxLabel.isNotEmpty()) {
                                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                                    if (nonOffLevels.isNotEmpty() || option.reasoning) {
                                                        Surface(
                                                            color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.7f),
                                                            shape = RoundedCornerShape(4.dp),
                                                        ) {
                                                            Text(
                                                                if (nonOffLevels.isNotEmpty()) "🧠 思考 ${nonOffLevels.size} 档" else "🧠 支持思考",
                                                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                                                                style = MaterialTheme.typography.labelSmall,
                                                                color = MaterialTheme.colorScheme.onTertiaryContainer,
                                                            )
                                                        }
                                                    }
                                                    if (ctxLabel.isNotEmpty()) {
                                                        Surface(
                                                            color = MaterialTheme.colorScheme.surface,
                                                            shape = RoundedCornerShape(4.dp),
                                                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)),
                                                        ) {
                                                            Text(
                                                                "📦 $ctxLabel 上下文",
                                                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                                                                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                            )
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        if (selected) {
                                            Text("✓", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (thinking) TextButton(enabled = !busy && level.isNotBlank() && !level.equals(summary?.thinkingLevel, ignoreCase = true), onClick = { onThinking(level.trim()) }) { Text("应用", style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold)) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(if (thinking) "取消" else "关闭", style = PiType.footnote) } },
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
