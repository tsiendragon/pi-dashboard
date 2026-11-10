package com.sam.pidash.ui.live

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveDirectoryOption
import com.sam.pidash.domain.model.searchLiveDirectories
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

@Composable
internal fun LiveDirectoryChoice(
    option: LiveDirectoryOption,
    selected: Boolean = false,
    enabled: Boolean = true,
    onSelect: () -> Unit,
) {
    Surface(
        onClick = onSelect, enabled = enabled,
        modifier = Modifier.fillMaxWidth(), shape = Radii.card,
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(Hairline, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.heightIn(min = 48.dp).padding(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text(option.name, modifier = Modifier.weight(1f), style = PiType.footnote)
                Text(if (selected) "已选" else if (option.project) "项目" else "根目录",
                    style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // Do not ellipsize: different projects can share the same basename.
            Text(option.path, style = PiType.monoMicro, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun LiveDirectoryPicker(
    serverName: String,
    options: List<LiveDirectoryOption>,
    currentPath: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val matches = remember(options, query) { searchLiveDirectories(options, query) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择工作目录") },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(max = 440.dp), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text(serverName, style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                PiTextField(
                    value = query, onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth(), label = "搜索项目或路径",
                    placeholder = "例如 pi、dashboard 或 /srv",
                    trailing = { if (query.isNotEmpty()) TextButton(onClick = { query = "" }) { Text("清空") } },
                )
                Text("目录建议：${matches.size} / ${options.size}", style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (matches.isEmpty()) {
                    Text(if (options.isEmpty()) "服务器暂无目录建议，可返回手动填写绝对路径。"
                        else "没有匹配的目录，试试其他关键词，或返回手动填写绝对路径。",
                        style = PiType.footnote)
                } else {
                    LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        items(matches, key = { it.path }) { option ->
                            LiveDirectoryChoice(option, selected = option.path == currentPath, onSelect = { onSelect(option.path) })
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("返回") } },
    )
}
