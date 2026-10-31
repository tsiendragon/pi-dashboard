package com.sam.pidash.ui.backends

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.sam.pidash.PiDashApp

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.DashboardClient
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.AppFontScale
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.ui.common.AppVersionLabel
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.SectionLabel
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.common.backendOriginLabel
import com.sam.pidash.ui.common.liveConnectionLabel
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackendsScreen(repo: PiDashRepository, onBack: () -> Unit) {
    val backends by repo.backends.collectAsState()
    val connection by repo.connection.collectAsState()
    val liveStates by repo.live.backendStates.collectAsState()
    val scope = rememberCoroutineScope()
    var showAdd by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val notifier = remember { (context.applicationContext as PiDashApp).notifier }
    val displayPrefs = remember { (context.applicationContext as PiDashApp).displayPrefs }
    val fontScale by displayPrefs.fontScale.collectAsState()
    var alertsEnabled by remember { mutableStateOf(notifier.prefs.enabled) }
    var alertsNeedsPermission by remember { mutableStateOf(false) }
    // Android 13+: enabling alerts asks for the runtime permission instead of failing silently.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        alertsNeedsPermission = !granted
        if (granted) { notifier.prefs.enabled = true; alertsEnabled = true }
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
                            "设置",
                            style = PiType.headline,
                            maxLines = 1,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        AppVersionLabel()
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { showAdd = true }) {
                Icon(Icons.Filled.Add, contentDescription = "添加服务器")
            }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = Spacing.lg),
            contentPadding = PaddingValues(top = Spacing.sm, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            item { SectionLabel("显示") }
            item {
                GroupedCard {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        Text("字体大小", style = PiType.callout, maxLines = 1)
                        Text(
                            "默认跟随系统字号，可再整体缩小或放大；仅影响本 App，重启后保留。",
                            style = PiType.caption,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            AppFontScale.entries.forEach { option ->
                                FilterChip(
                                    selected = fontScale == option,
                                    onClick = { displayPrefs.setFontScale(option) },
                                    label = { Text(option.label) },
                                )
                            }
                        }
                    }
                }
            }
            item { SectionLabel("本地缓存") }
            item {
                GroupedCard {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
                        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                    ) {
                        Text("最近的 Live 会话正文", style = PiType.callout)
                        Text(
                            "最近访问的对话记录及部分工具输出会加密保存在本机，最多 7 天；图片和待处理请求不缓存。断开或重新登录时会尝试清除。缓存仅用于快速显示，仍需与服务器同步。",
                            style = PiType.caption,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            item { SectionLabel("服务器") }
            if (backends.isEmpty()) {
                item {
                    Box(Modifier.fillMaxWidth().padding(vertical = Spacing.xl)) {
                        Text(
                            "还没有服务器\n点右下角 + 添加一台",
                            modifier = Modifier.align(Alignment.Center),
                            style = PiType.footnote,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            items(backends, key = { it.id }) { backend ->
                GroupedCard {
                    Row(
                        Modifier.fillMaxWidth().padding(start = Spacing.lg, end = Spacing.xs, top = Spacing.md, bottom = Spacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                            Text(
                                backend.name,
                                style = PiType.headline,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                backendOriginLabel(backend.baseUrl),
                                style = PiType.monoMicro,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                            ) {
                                ConnectionDot(connection[backend.id] ?: ConnectionState.Disconnected)
                                Text(
                                    "Chat：" + connectionLabel(connection[backend.id]),
                                    style = PiType.caption,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                )
                            }
                            MetaText(liveConnectionLabel(liveStates[backend.id]), maxLines = 1)
                        }
                        IconButton(onClick = { scope.launch { repo.removeBackend(backend.id) } }) {
                            Icon(
                                Icons.Filled.Delete,
                                contentDescription = "删除",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            item { SectionLabel("通知") }
            item {
                GroupedCard {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                            Text("后台会话提醒", style = PiType.callout, maxLines = 1)
                            Text(
                                "会话完成或等你回答时发系统通知。仅在 App 仍在运行且退到后台时生效，" +
                                    "不含消息正文、命令或路径；进程被系统回收后不再提醒。",
                                style = PiType.caption,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(checked = alertsEnabled, onCheckedChange = { want ->
                            if (!want) {
                                notifier.prefs.enabled = false
                                alertsEnabled = false
                                alertsNeedsPermission = false
                                return@Switch
                            }
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                                PackageManager.PERMISSION_GRANTED
                            ) {
                                permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                            } else {
                                notifier.prefs.enabled = true
                                alertsEnabled = true
                            }
                        })
                    }
                    if (alertsNeedsPermission) Text(
                        "系统未授予通知权限，提醒不会出现；可到系统设置里打开本应用的通知。",
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(start = Spacing.lg, end = Spacing.lg, bottom = Spacing.md),
                    )
                }
            }
        }
    }

    if (showAdd) {
        AddBackendDialog(
            onDismiss = { showAdd = false },
            onSave = { name, url, token ->
                scope.launch {
                    repo.addBackend(name, url, token)
                    showAdd = false
                }
            },
        )
    }
}

@Composable
private fun ConnectionDot(state: ConnectionState) {
    val color = when (state) {
        ConnectionState.Connected -> MaterialTheme.colorScheme.secondary
        ConnectionState.Connecting -> MaterialTheme.colorScheme.primary
        ConnectionState.Error -> MaterialTheme.colorScheme.error
        ConnectionState.Disconnected -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
    }
    StatusDot(color, size = 7.dp)
}

private fun connectionLabel(state: ConnectionState?): String = when (state) {
    ConnectionState.Connected -> "已连接"
    ConnectionState.Connecting -> "连接中…"
    ConnectionState.Error -> "连接失败（自动重试中）"
    ConnectionState.Disconnected -> "未连接"
    null -> "未连接"
}

@Composable
private fun AddBackendDialog(
    onDismiss: () -> Unit,
    onSave: (name: String, url: String, token: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("https://") }
    var token by remember { mutableStateOf("") }
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("添加服务器", style = PiType.headline) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名称（可留空）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("地址") },
                    placeholder = { Text("https://pi.example.com") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("凭据（可留空）") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                testResult?.let {
                    Text(it, style = PiType.footnote)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = url.isNotBlank() && !testing,
                onClick = { onSave(name, url, token) },
            ) { Text("保存") }
        },
        dismissButton = {
            Row {
                TextButton(
                    enabled = !testing && url.isNotBlank(),
                    onClick = {
                        testing = true
                        testResult = null
                        scope.launch {
                            testResult = DashboardClient.testConnection(url, token)
                                .getOrElse { "失败：${it.message ?: it::class.simpleName}" }
                            testing = false
                        }
                    },
                ) { Text(if (testing) "测试中…" else "测试") }
                Spacer(Modifier.width(4.dp))
                TextButton(onClick = onDismiss) { Text("取消") }
            }
        },
    )
}
