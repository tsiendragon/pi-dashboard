package com.sam.pidash.ui.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.activityStatus
import com.sam.pidash.domain.model.groupTranscript
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing

/**
 * Full record for one turn: every step, its arguments, its output and the thinking.
 * Opened from a card, so the reading surface stays clean until asked.
 */
@Composable
internal fun ActivityDetailDialog(
    activity: LiveActivity,
    enabled: Boolean,
    onDismiss: () -> Unit,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onQuote: (LiveTimelineItem) -> Unit,
    onAnnotate: (LiveTimelineItem) -> Unit,
    onFork: (String) -> Unit,
) {
    val status = activityStatus(activity)

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, end = Spacing.lg, top = 4.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", Modifier.size(20.dp))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            "本轮记录",
                            style = PiType.callout.copy(fontWeight = FontWeight.SemiBold),
                            maxLines = 1,
                        )
                        MetaText(
                            listOfNotNull(status.label, "${activity.items.size} 条记录").joinToString("  ·  "),
                            tint = if (status.failed) MaterialTheme.colorScheme.error else null,
                        )
                    }
                    if (status.running) StatusDot(MaterialTheme.colorScheme.primary, size = 6.dp)
                }
                HorizontalDivider(thickness = Hairline, color = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f))
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = Spacing.md, vertical = Spacing.sm),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    items(groupTranscript(activity.items), key = { it.id }) { row ->
                        NativeTimelineRow(row, onOpenPath, onOpenUrl, onFork, enabled, onQuote, onAnnotate, compactUser = true)
                    }
                }
            }
        }
    }
}
