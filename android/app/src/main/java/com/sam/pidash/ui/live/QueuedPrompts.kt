package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.LiveQueueItem
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints

/**
 * Prompts the bridge still holds, shown as one quiet line above the composer.
 *
 * The composer stays a single object; queued text is one tap away in a sheet where each
 * row can be withdrawn. A prompt already handed to pi says so instead of offering a
 * button that could not work.
 */
@Composable
internal fun QueuedPromptsBar(
    items: List<LiveQueueItem>,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (items.isEmpty()) return
    val scheme = MaterialTheme.colorScheme
    Row(
        modifier.fillMaxWidth()
            .background(scheme.surfaceVariant.copy(alpha = Tints.Block), Radii.chip)
            .border(1.dp, scheme.outline.copy(alpha = Tints.Border), Radii.chip)
            .heightIn(min = 48.dp)
            .padding(start = Spacing.md, end = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "排队 ${items.size} 条",
            style = PiType.caption.copy(fontWeight = FontWeight.SemiBold),
            color = scheme.onSurfaceVariant,
        )
        Text(
            items.first().text.replace('\n', ' '),
            modifier = Modifier.weight(1f).padding(horizontal = Spacing.sm),
            style = PiType.caption,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp)) { Text("查看", style = PiType.action) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun QueuedPromptsSheet(
    items: List<LiveQueueItem>,
    active: LiveQueueItem?,
    busy: Boolean,
    error: String?,
    onCancel: (LiveQueueItem) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, shape = Radii.sheet) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.lg).padding(bottom = Spacing.xl),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text("排队的消息", style = PiType.pageTitle)
            Text(
                "这些消息还在本机排队，尚未交给 Agent。撤回只影响还没开始执行的那一条。",
                style = PiType.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            error?.let { Text(it, style = PiType.caption, color = MaterialTheme.colorScheme.error) }
            items.forEach { item ->
                Column(Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(vertical = Spacing.xs)) {
                            Text(
                                item.text.ifBlank { "（图片）" },
                                style = PiType.callout,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                buildString {
                                    append(if (item.deliverAs == "steer") "引导" else "排队")
                                    if (item.imageCount > 0) append(" · ${item.imageCount} 张图片")
                                    item.channel.takeIf { it.isNotBlank() }?.let { append(" · $it") }
                                },
                                style = PiType.caption,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(enabled = !busy, onClick = { onCancel(item) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("撤回", style = PiType.action) }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline))
                }
            }
            active?.let { item ->
                Text(
                    "正在发送：${item.text.replace('\n', ' ').take(60)}",
                    style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (items.isEmpty()) Text(
                "没有排队中的消息。",
                style = PiType.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}