package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

@Composable
internal fun SessionModeTabs(liveTab: Boolean, onChange: (Boolean) -> Unit) {
    TabRow(
        selectedTabIndex = if (liveTab) 0 else 1,
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.primary,
        divider = { HorizontalDivider(thickness = Hairline) },
    ) {
        listOf(true to "Live Pi", false to "Chat").forEach { (live, label) ->
            Tab(
                selected = liveTab == live, onClick = { onChange(live) },
                modifier = Modifier.heightIn(min = 48.dp),
                selectedContentColor = MaterialTheme.colorScheme.primary,
                unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
            ) {
                Text(label, style = PiType.footnote, modifier = Modifier.padding(vertical = Spacing.sm))
            }
        }
    }
}

@Composable
internal fun LiveConnectionStrip(
    label: String,
    connected: Boolean,
    needsToken: Boolean,
    error: String?,
    onInfo: () -> Unit,
    onAuthAction: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.md)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            StatusDot(if (connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
            Text(label, style = PiType.footnote, modifier = Modifier.weight(1f))
            IconButton(onClick = onInfo, modifier = Modifier.size(48.dp)) {
                Icon(Icons.Filled.Info, "连接与只读说明", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = onAuthAction, modifier = Modifier.heightIn(min = 48.dp),
                contentPadding = PaddingValues(horizontal = Spacing.sm)) {
                Text(if (needsToken) "登录" else "断开", style = PiType.footnote)
            }
        }
        error?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = PiType.footnote, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(bottom = Spacing.sm))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SessionListControls(
    query: String,
    onQueryChange: (String) -> Unit,
    runningOnly: Boolean,
    onRunningChange: () -> Unit,
    children: Boolean,
    onChildrenChange: () -> Unit,
    sorting: Boolean,
    onSortingChange: () -> Unit,
    canGroup: Boolean,
    canSort: Boolean,
    onGroups: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = query, onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth().semantics { contentDescription = "搜索会话" },
            placeholder = { Text("搜索会话", style = PiType.footnote,
                maxLines = 1, overflow = TextOverflow.Ellipsis) },
            textStyle = PiType.body,
            leadingIcon = { Icon(Icons.Filled.Search, null, Modifier.size(18.dp)) },
            trailingIcon = if (query.isNotEmpty()) {{
                IconButton(onClick = { onQueryChange("") }) {
                    Icon(Icons.Filled.Close, "清除搜索", Modifier.size(18.dp))
                }
            }} else null,
            singleLine = true, enabled = !sorting, shape = Radii.card,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ListFilter("工作中", runningOnly, !sorting, onRunningChange)
            ListFilter("子 Agent", children, !sorting, onChildrenChange)
            AssistChip(
                onClick = onGroups, enabled = canGroup, label = { Text("分组", style = PiType.footnote) },
                shape = Radii.chip, border = null,
                colors = AssistChipDefaults.assistChipColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                ),
            )
            ListFilter(if (sorting) "完成排序" else "排序", sorting, canSort, onSortingChange)
        }
    }
}

@Composable
private fun ListFilter(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    FilterChip(
        selected = selected, enabled = enabled, onClick = onClick,
        label = { Text(label, style = PiType.footnote) }, shape = Radii.chip, border = null,
        colors = FilterChipDefaults.filterChipColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
            selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
            selectedLabelColor = MaterialTheme.colorScheme.primary,
        ),
    )
}
