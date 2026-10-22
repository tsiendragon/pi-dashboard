package com.sam.pidash.ui.live

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.activityReplies
import com.sam.pidash.data.remote.activityTools
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.domain.model.groupTranscript
import com.sam.pidash.ui.common.MetaAction
import com.sam.pidash.ui.common.MetaLine
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing

/**
 * Default view: one card per turn, showing what the agent *answered*.
 *
 * A phone cannot read a full transcript, so the activity view keeps only:
 * the prompt as a one-line anchor, one collapsed line for the tool run, and the
 * reply body. The complete record (thinking, every step, arguments) stays one tap
 * away — nothing is hidden, it is just not the default.
 */
@Composable
internal fun NativeActivityCard(
    activity: LiveActivity,
    onOpenPath: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onQuote: (LiveTimelineItem) -> Unit,
    onAnnotate: (LiveTimelineItem) -> Unit,
    onFork: (String) -> Unit,
    enabled: Boolean,
) {
    var showRecord by remember(activity.id) { mutableStateOf(false) }
    var showThinking by remember(activity.id) { mutableStateOf(false) }

    val prompt = activity.items.firstOrNull { it.role == "user" }?.text?.trim().orEmpty()
    val tools = activityTools(activity)
    val shown = activityReplies(activity)
    val thinking = activity.items.mapNotNull { it.thinking?.takeIf { text -> text.isNotBlank() } }
    val errors = activity.items.filter { it.isError }
    val running = activity.state == "工作中"
    val failed = errors.isNotEmpty()

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        if (prompt.isNotBlank()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (running) {
                    StatusDot(MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.size(Spacing.sm))
                }
                Text(
                    prompt,
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (tools.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().clickable { showRecord = !showRecord }.padding(vertical = Spacing.xs),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (showRecord) "⌃" else "⌄",
                    style = PiType.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(Spacing.xs))
                Text(
                    if (tools.size == 1) "1 个步骤" else "${tools.size} 个步骤",
                    style = PiType.footnote.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold),
                )
                Spacer(Modifier.size(Spacing.sm))
                MetaLine(
                    listOfNotNull(
                        activity.state.takeIf { it.isNotBlank() },
                        tools.mapNotNull { it.toolName }.distinct().take(3).joinToString(" · ").takeIf { it.isNotBlank() },
                    ),
                    tint = if (failed) MaterialTheme.colorScheme.error else null,
                )
            }
        }
        if (showRecord) Column(Modifier.fillMaxWidth()) {
            groupTranscript(activity.items).forEach { row ->
                NativeTimelineRow(row, onOpenPath, onOpenUrl, onFork, enabled, onQuote, onAnnotate)
            }
        }
        if (!showRecord) {
            shown.forEach { reply ->
                MarkdownBody(
                    reply.text,
                    onOpenPath = onOpenPath,
                    onOpenUrl = onOpenUrl,
                    style = PiType.body,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    MetaAction("引用", { onQuote(reply) }, enabled)
                    MetaAction("批注", { onAnnotate(reply) }, enabled)
                    if (reply.forkable && !reply.entryId.isNullOrBlank()) MetarecordFork(reply.entryId, onFork, enabled)
                }
            }
            if (shown.isEmpty() && tools.isEmpty() && prompt.isNotBlank()) {
                Text("（这一轮还没有正文回复）", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            errors.forEach { error ->
                Text(
                    error.text.ifBlank { "工具执行失败" },
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (thinking.isNotEmpty()) {
                MetaAction(if (showThinking) "收起思考" else "思考 ${thinking.size} 段", { showThinking = !showThinking })
                if (showThinking) thinking.forEach {
                    Text(
                        it,
                        style = PiType.monoMicro,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = Spacing.md),
                    )
                }
            }
        }
    }
}

@Composable
private fun MetarecordFork(entryId: String, onFork: (String) -> Unit, enabled: Boolean) {
    MetaAction("分叉", { onFork(entryId) }, enabled)
}
