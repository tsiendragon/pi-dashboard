package com.sam.pidash.ui.backends

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.sam.pidash.PiDashApp

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.DashboardClient
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.ui.common.AppVersionLabel
import com.sam.pidash.ui.common.backendOriginLabel
import com.sam.pidash.ui.common.liveConnectionLabel
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
    var alertsEnabled by remember { mutableStateOf(notifier.prefs.enabled) }
    var alertsNeedsPermission by remember { mutableStateOf(false) }
    // Android 13+: enabling alerts asks for the runtime permission instead of failing silently.
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        alertsNeedsPermission = !granted
        if (granted) { notifier.prefs.enabled = true; alertsEnabled = true }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column { Text("服务器"); AppVersionLabel() } },
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
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (backends.isEmpty()) {
                Text(
                    "还没有服务器\n点右下角 + 添加一台",
                    modifier = Modifier.align(Alignment.Center),
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 88.dp),
                ) {
                    items(backends, key = { it.id }) { backend ->
                        ListItem(
                            headlineContent = { Text(backend.name) },
                            supportingContent = {
                                Column {
                                    Text(backendOriginLabel(backend.baseUrl), style = MaterialTheme.typography.bodySmall)
                                    Text(
                                        "普通 Chat：" + connectionLabel(connection[backend.id]),
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                    Text(liveConnectionLabel(liveStates[backend.id]), style = MaterialTheme.typography.labelSmall)
                                }
                            },
                            leadingContent = {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("Chat", style = MaterialTheme.typography.labelSmall)
                                    ConnectionDot(connection[backend.id] ?: ConnectionState.Disconnected)
                                }
                            },
                            trailingContent = {
                                IconButton(onClick = { scope.launch { repo.removeBackend(backend.id) } }) {
                                    Icon(Icons.Filled.Delete, contentDescription = "删除")
                                }
                            },
                        )
                        HorizontalDivider()
                    }
                    item {
                        ListItem(
                            headlineContent = { Text("后台会话提醒") },
                            supportingContent = {
                                Text(
                                    "会话完成或等你回答时发系统通知。仅在 App 仍在运行且退到后台时生效，" +
                                        "不含消息正文、命令或路径；进程被系统回收后不再提醒。",
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            },
                            trailingContent = {
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
                            },
                        )
                        if (alertsNeedsPermission) Text(
                            "系统未授予通知权限，提醒不会出现；可到系统设置里打开本应用的通知。",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                        HorizontalDivider()
                    }
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
        ConnectionState.Connected -> Color(0xFF2E7D32)
        ConnectionState.Connecting -> Color(0xFFF9A825)
        ConnectionState.Error -> Color(0xFFC62828)
        ConnectionState.Disconnected -> Color(0xFF9E9E9E)
    }
    Box(Modifier.size(10.dp).clip(CircleShape).background(color))
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
        title = { Text("添加服务器") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                    Text(it, style = MaterialTheme.typography.bodySmall)
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
