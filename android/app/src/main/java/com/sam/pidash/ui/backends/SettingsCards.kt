package com.sam.pidash.ui.backends

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.app.TimePickerDialog
import android.os.Build
import com.sam.pidash.BuildConfig
import com.sam.pidash.data.local.CacheRetention
import com.sam.pidash.data.local.LiveDetailCache
import com.sam.pidash.data.local.LiveDetailCacheStats
import com.sam.pidash.data.local.SettingsPrefs
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.domain.model.LiveBackendState
import com.sam.pidash.notify.NotificationPrefs
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.common.SegmentedTabs
import com.sam.pidash.ui.common.appVersionText
import com.sam.pidash.ui.common.backendOriginLabel
import com.sam.pidash.ui.common.liveConnectionLabel
import com.sam.pidash.ui.live.THINKING_LADDER_LEVELS
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/* ─────────────────────────── New-session defaults ─────────────────────────── */

@Composable
internal fun SessionDefaultsCard(prefs: SettingsPrefs) {
    var editing by remember { mutableStateOf(false) }
    val deliver by prefs.defaultDeliver.collectAsState()
    val model by prefs.defaultModel.collectAsState()
    val thinking by prefs.defaultThinking.collectAsState()
    GroupedCard {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text("默认投递方式", style = PiType.callout)
            Text(
                "新会话里默认怎么发送：引导会在当前回合插话，排队等这一轮结束再发；可随时在输入框旁改。",
                style = PiType.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SegmentedTabs(
                options = listOf("" to "跟随服务器", "steer" to "立即引导", "followUp" to "排队"),
                selected = deliver,
                onSelect = prefs::setDefaultDeliver,
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
            Row(
                Modifier.fillMaxWidth().clickable { editing = true }.padding(vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    Text("新会话默认模型与思考", style = PiType.callout)
                    Text(
                        listOf(
                            model.ifBlank { "模型：服务器默认" },
                            "思考：" + (thinking.ifBlank { "服务器默认" }),
                        ).joinToString(" · "),
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text("修改", style = PiType.action, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
    if (editing) SessionDefaultsDialog(
        initialModel = model,
        initialThinking = thinking,
        onDismiss = { editing = false },
        onSave = { nextModel, nextThinking ->
            prefs.setDefaultModel(nextModel)
            prefs.setDefaultThinking(nextThinking)
            editing = false
        },
    )
}

@Composable
private fun SessionDefaultsDialog(
    initialModel: String,
    initialThinking: String,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var model by remember { mutableStateOf(initialModel) }
    var thinking by remember { mutableStateOf(initialThinking) }
    AlertDialog(shape = Radii.sheet,
        onDismissRequest = onDismiss,
        title = { Text("新会话默认值", style = PiType.pageTitle) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                PiTextField(
                    value = model,
                    onValueChange = { model = it },
                    label = "模型（provider/id，可留空）",
                    placeholder = "例如 anthropic/claude-sonnet-4",
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("思考强度", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    for ((id, label) in listOf("" to "默认") + THINKING_LADDER_LEVELS.map { it.id to it.title.substringBefore(" · ") }) {
                        TextButton(
                            onClick = { thinking = id },
                            modifier = Modifier.heightIn(min = 48.dp),
                        ) {
                            Text(
                                label,
                                style = if (thinking == id) PiType.action.copy(
                                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                                ) else PiType.action,
                                color = if (thinking == id) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Text(
                    "只预填新建会话；已有会话的模型与思考仍在会话菜单里改。",
                    style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSave(model, thinking) }) { Text("保存") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/* ─────────────────────────────── Local cache ─────────────────────────────── */

@Composable
internal fun CacheCard(prefs: SettingsPrefs, cache: LiveDetailCache) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val enabled by prefs.cacheEnabled.collectAsState()
    val retention by prefs.cacheRetention.collectAsState()
    var confirmClear by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val stats by produceState<LiveDetailCacheStats?>(null, enabled, retention, refreshing) {
        value = runCatching { cache.stats() }.getOrDefault(LiveDetailCacheStats())
    }
    GroupedCard {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                Column(
                    Modifier.weight(1f).padding(end = Spacing.xs),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                ) {
                    Text("离线缓存正文", style = PiType.callout)
                    Text(
                        "最近访问的对话会加密保存在本机，用于断网或重新打开时先显示；仍需与服务器同步。关闭后不再读写新缓存。",
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = enabled, onCheckedChange = { prefs.setCacheEnabled(it); message = null })
            }
            if (enabled) {
                Text("保留时长", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SegmentedTabs(
                    options = CacheRetention.entries.map { it.days.toString() to it.label },
                    selected = retention.days.toString(),
                    onSelect = { days ->
                        CacheRetention.entries.firstOrNull { it.days == days.toIntOrNull() }?.let(prefs::setCacheRetention)
                    },
                )
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
            Text(
                stats?.let { cacheSummary(it) } ?: "正在统计缓存…",
                style = PiType.footnote,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            message?.let { Text(it, style = PiType.caption, color = MaterialTheme.colorScheme.primary) }
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                TextButton(
                    enabled = !refreshing,
                    onClick = {
                        refreshing = true
                        scope.launch {
                            runCatching { cache.stats() }
                            refreshing = false
                        }
                    },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("刷新") }
                TextButton(
                    enabled = (stats?.entries ?: 0) > 0,
                    onClick = { confirmClear = true },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("清除缓存", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    if (confirmClear) AlertDialog(shape = Radii.sheet,
        onDismissRequest = { confirmClear = false },
        title = { Text("清除本机缓存？", style = PiType.pageTitle) },
        text = {
            Text(
                "会删除所有已加密保存的对话正文（仅本机，不影响服务器上的会话）；下次打开需要联网读取。",
                style = PiType.footnote,
            )
        },
        confirmButton = {
            TextButton(onClick = {
                confirmClear = false
                scope.launch {
                    val removed = runCatching { cache.clearAll() }.isSuccess
                    message = if (removed) "缓存已清除" else "清除失败，请稍后再试"
                    refreshing = !refreshing
                }
            }) { Text("清除", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("取消") } },
    )
}

internal fun cacheSummary(stats: LiveDetailCacheStats): String {
    if (stats.entries == 0) return "暂无缓存"
    val time = stats.lastSavedAt?.let { SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(it)) }
    return "已用 ${formatBytes(stats.bytes)} · ${stats.entries} 条" + (time?.let { " · 最近 $it" } ?: "")
}

internal fun formatBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024L -> String.format(Locale.getDefault(), "%.1f MB", bytes / (1024.0 * 1024.0))
    bytes >= 1024L -> String.format(Locale.getDefault(), "%.0f KB", bytes / 1024.0)
    else -> "$bytes B"
}

/* ─────────────────────────────── Notifications ─────────────────────────────── */

@Composable
internal fun NotificationDetailsCard(prefs: NotificationPrefs) {
    val context = LocalContext.current
    var completed by remember { mutableStateOf(prefs.completed) }
    var needsInput by remember { mutableStateOf(prefs.needsInput) }
    var hideTitle by remember { mutableStateOf(prefs.hideTitle) }
    var quiet by remember { mutableStateOf(prefs.quietEnabled) }
    GroupedCard {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            ToggleRow(
                label = "会话完成",
                hint = "这一轮回复结束、等你回来看结果时提醒。",
                checked = completed,
            ) { completed = it; prefs.completed = it }
            ToggleRow(
                label = "需要我回答 / 审批",
                hint = "Agent 停下来等你选、确认或授权时提醒；这类通常更值得开。",
                checked = needsInput,
            ) { needsInput = it; prefs.needsInput = it }
            ToggleRow(
                label = "通知里隐藏会话名称",
                hint = "通知仍会说明发生了什么事，但不显示会话标题，适合经常投屏或旁人在场。",
                checked = hideTitle,
            ) { hideTitle = it; prefs.hideTitle = it }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
            ToggleRow(
                label = "免打扰时段",
                hint = "时段内不弹通知；通知不会补发，回来打开 App 仍能看到状态。",
                checked = quiet,
            ) { quiet = it; prefs.quietEnabled = it }
            if (quiet) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(
                        onClick = { pickTime(context, prefs.quietStartMinutes) { prefs.quietStartMinutes = it } },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("开始 ${formatMinute(prefs.quietStartMinutes)}") }
                    Text("到", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(
                        onClick = { pickTime(context, prefs.quietEndMinutes) { prefs.quietEndMinutes = it } },
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text("结束 ${formatMinute(prefs.quietEndMinutes)}") }
                }
            }
        }
    }
}

@Composable
private fun ToggleRow(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Column(
            Modifier.weight(1f).padding(end = Spacing.xs),
            verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
        ) {
            Text(label, style = PiType.callout)
            Text(hint, style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

private fun pickTime(context: android.content.Context, minuteOfDay: Int, onPicked: (Int) -> Unit) {
    val dialog = TimePickerDialog(
        context,
        { _, hour, minute -> onPicked(hour * 60 + minute) },
        minuteOfDay / 60,
        minuteOfDay % 60,
        true,
    )
    dialog.show()
}

internal fun formatMinute(minuteOfDay: Int): String =
    String.format(Locale.US, "%02d:%02d", (minuteOfDay / 60) % 24, minuteOfDay % 60)

/* ────────────────────────────────── About ────────────────────────────────── */

@Composable
internal fun AboutCard(
    backends: List<Backend>,
    connection: Map<String, ConnectionState>,
    liveStates: Map<String, LiveBackendState>,
    cache: LiveDetailCache,
    notifications: NotificationPrefs,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var licenses by remember { mutableStateOf(false) }
    GroupedCard {
        Column(Modifier.fillMaxWidth().padding(vertical = Spacing.xs)) {
            AboutRow("版本", appVersionText(), onClick = null)
            AboutRow("查看新版本", "在 GitHub 查看最新安装包") {
                openExternal(context, "https://github.com/tsiendragon/pi-dashboard/releases")
            }
            AboutRow("开源许可", "Compose / OkHttp / kotlinx") { licenses = true }
            AboutRow("导出诊断信息", "版本、连接状态、缓存用量；不含会话内容与凭据") {
                scope.launch {
                    val stats = runCatching { cache.stats() }.getOrDefault(LiveDetailCacheStats())
                    val text = diagnosticsText(backends, connection, liveStates, stats, notifications)
                    shareText(context, text)
                }
            }
        }
    }
    if (licenses) LicensesDialog(onDismiss = { licenses = false })
}

@Composable
private fun AboutRow(label: String, value: String, onClick: (() -> Unit)?) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = Spacing.lg, vertical = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = PiType.callout)
        Text(
            value,
            modifier = Modifier.weight(1f).padding(start = Spacing.md),
            style = PiType.caption,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
        )
        if (onClick != null) Icon(
            Icons.Filled.KeyboardArrowRight,
            contentDescription = null,
            modifier = Modifier.padding(start = Spacing.xs),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LicensesDialog(onDismiss: () -> Unit) {
    val rows = listOf(
        "Jetpack Compose / AndroidX — Apache License 2.0",
        "OkHttp — Apache License 2.0",
        "kotlinx.serialization / kotlinx.coroutines — Apache License 2.0",
        "coil-compose (if present) — Apache License 2.0",
        "Robolectric / Roborazzi (tests only) — Apache License 2.0",
    )
    AlertDialog(shape = Radii.sheet,
        onDismissRequest = onDismiss,
        title = { Text("开源许可", style = PiType.pageTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                rows.forEach { Text(it, style = PiType.footnote) }
                Text(
                    "完整许可证文本见各依赖仓库；本应用不修改这些库。",
                    style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

internal fun diagnosticsText(
    backends: List<Backend>,
    connection: Map<String, ConnectionState>,
    liveStates: Map<String, LiveBackendState>,
    stats: LiveDetailCacheStats,
    notifications: NotificationPrefs,
): String = buildString {
    appendLine("PiDash Android ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
    appendLine("Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}")
    appendLine("服务器：${backends.size}")
    backends.forEach { backend ->
        appendLine(
            "- ${backendOriginLabel(backend.baseUrl)} · Chat ${connectionLabel(connection[backend.id])} · " +
                liveConnectionLabel(liveStates[backend.id]),
        )
    }
    appendLine("缓存：${cacheSummary(stats)}")
    val quiet = if (notifications.quietEnabled) {
        "${formatMinute(notifications.quietStartMinutes)}–${formatMinute(notifications.quietEndMinutes)}"
    } else {
        "关"
    }
    appendLine(
        "通知：总开关 ${if (notifications.enabled) "开" else "关"} · " +
            "完成 ${if (notifications.completed) "开" else "关"} · " +
            "需要回答 ${if (notifications.needsInput) "开" else "关"} · 免打扰 $quiet",
    )
}

private fun shareText(context: android.content.Context, text: String) {
    runCatching {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "PiDash 诊断信息")
            putExtra(Intent.EXTRA_TEXT, text)
        }
        context.startActivity(Intent.createChooser(send, "导出诊断信息"))
    }
}

private fun openExternal(context: android.content.Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}

private fun connectionLabel(state: ConnectionState?): String = when (state) {
    ConnectionState.Connected -> "已连接"
    ConnectionState.Connecting -> "连接中"
    ConnectionState.Error -> "连接失败"
    ConnectionState.Disconnected, null -> "未连接"
}
