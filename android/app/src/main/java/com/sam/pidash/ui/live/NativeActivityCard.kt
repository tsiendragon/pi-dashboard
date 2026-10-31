package com.sam.pidash.ui.live

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.activityReplies
import com.sam.pidash.data.remote.activityTools
import com.sam.pidash.domain.model.FollowUpKind
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.activityStatus
import com.sam.pidash.domain.model.followUpSummary
import com.sam.pidash.domain.model.quoteOrCommentKind
import com.sam.pidash.ui.common.MetaAction
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

private const val CARD_REPLY_LINES = 16
private const val CARD_REPLY_CHARS = 1400

/**
 * WebUI-style Activity Card for mobile:
 * - Header: user request badge + prompt text
 * - Body: progress notes, collapsible execution steps (`⚡ 执行步骤`), collapsible thinking (`💭 思考过程`),
 *   quote/comment follow-ups, and rendered Markdown reply
 * - Footer: turn status badge + action to open full record / quote / fork
 */
@Composable
internal fun NativeActivityCard(
    activity: LiveActivity,
    onOpen: () -> Unit,
    onOpenPath: (String) -> Unit = {},
    onOpenUrl: (String) -> Unit = {},
) {
    val scheme = MaterialTheme.colorScheme
    val status = activityStatus(activity)
    val firstUser = activity.items.firstOrNull { it.role == "user" }
    val prompt = firstUser?.text?.trim().orEmpty()
    val followUps = remember(activity.items, firstUser) {
        activity.items.filter { it.role == "user" && it !== firstUser && it.text.isNotBlank() }
    }
    val tools = remember(activity.items) { activityTools(activity) }
    val replies = remember(activity.items) { activityReplies(activity) }
    val progressNotes = remember(activity.items, replies) {
        val replyIds = replies.map { it.id }.toSet()
        activity.items.filter {
            it.role == "assistant" && it.text.isNotBlank() && it.id !in replyIds &&
                (it.intermediate || it.channel == "commentary")
        }
    }
    val thinkingText = remember(activity.items) {
        activity.items.mapNotNull { it.thinking?.trim()?.takeIf { t -> t.isNotEmpty() } }
            .distinct()
            .joinToString("\n\n")
    }

    var stepsExpanded by remember(activity.id) { mutableStateOf(tools.size <= 4 || status.running) }
    var thinkingExpanded by remember(activity.id) { mutableStateOf(false) }
    var promptExpanded by remember(activity.id) { mutableStateOf(false) }
    var replyExpanded by remember(activity.id) { mutableStateOf(false) }

    val accent = when {
        status.failed -> scheme.error
        status.running -> scheme.primary
        else -> null
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = scheme.surface,
        border = BorderStroke(
            width = if (status.running) 1.5.dp else 1.dp,
            color = accent?.copy(alpha = 0.55f) ?: scheme.outline.copy(alpha = 0.35f),
        ),
        tonalElevation = 1.dp,
    ) {
        Column(Modifier.fillMaxWidth()) {
            // ── 1. Activity Header (User Request) ──
            Column(
                Modifier.fillMaxWidth()
                    .background(scheme.secondaryContainer.copy(alpha = 0.45f))
                    .clickable { promptExpanded = !promptExpanded }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Surface(
                        color = scheme.primary.copy(alpha = 0.14f),
                        shape = RoundedCornerShape(99.dp),
                    ) {
                        Text(
                            if (firstUser != null) "👤 用户请求" else "📌 窗口内活动",
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                            style = PiType.micro.copy(fontWeight = FontWeight.SemiBold),
                            color = scheme.primary,
                        )
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (tools.isNotEmpty()) {
                            MetaText("${tools.size} 步操作")
                        }
                        if (followUps.isNotEmpty()) {
                            MetaText("追问 ${followUps.size}")
                        }
                    }
                }
                if (prompt.isNotBlank()) {
                    Text(
                        prompt,
                        style = PiType.callout.copy(fontWeight = FontWeight.Medium),
                        color = scheme.onSurface,
                        maxLines = if (promptExpanded) 24 else 4,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else if (firstUser?.images?.isNotEmpty() == true) {
                    MetaText("用户发送了 ${firstUser.images.size} 张图片")
                } else {
                    MetaText("已有活动（窗口内记录）")
                }
            }

            HorizontalDivider(color = scheme.outline.copy(alpha = 0.2f))

            // ── 2. Activity Body ──
            Column(
                Modifier.fillMaxWidth().padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // Progress / Plan notes
                if (progressNotes.isNotEmpty()) {
                    Column(
                        Modifier.fillMaxWidth()
                            .background(scheme.surfaceVariant.copy(alpha = 0.55f), RoundedCornerShape(8.dp))
                            .border(1.dp, scheme.outline.copy(alpha = 0.3f), RoundedCornerShape(8.dp))
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            "📋 进度说明 (${progressNotes.size})",
                            style = PiType.micro.copy(fontWeight = FontWeight.SemiBold),
                            color = scheme.onSurfaceVariant,
                        )
                        progressNotes.takeLast(3).forEach { note ->
                            Text(
                                "• ${note.text.replace('\n', ' ').trim()}",
                                style = PiType.footnote,
                                color = scheme.onSurface,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }

                // Collapsible Execution Steps (`⚡ 执行步骤`)
                if (tools.isNotEmpty()) {
                    val runningCount = tools.count { it.status == "running" }
                    val errorCount = tools.count { it.isError }
                    val stepSummary = when {
                        errorCount > 0 -> "${tools.size} 步 · $errorCount 步失败"
                        runningCount > 0 -> "${tools.size} 步 · $runningCount 步执行中"
                        else -> "${tools.size} 步全部完成"
                    }
                    Column(
                        Modifier.fillMaxWidth()
                            .background(scheme.surfaceVariant.copy(alpha = 0.45f), RoundedCornerShape(8.dp))
                            .border(1.dp, scheme.outline.copy(alpha = 0.35f), RoundedCornerShape(8.dp)),
                    ) {
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable { stepsExpanded = !stepsExpanded }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    "⚡ 执行步骤",
                                    style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                                    color = scheme.onSurface,
                                )
                                Surface(
                                    color = if (errorCount > 0) scheme.errorContainer else scheme.surface,
                                    shape = RoundedCornerShape(99.dp),
                                ) {
                                    Text(
                                        stepSummary,
                                        modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp),
                                        style = PiType.monoMicro,
                                        color = if (errorCount > 0) scheme.onErrorContainer else scheme.onSurfaceVariant,
                                    )
                                }
                            }
                            Text(
                                if (stepsExpanded) "收起 ▴" else "展开 ▾",
                                style = PiType.micro,
                                color = scheme.onSurfaceVariant,
                            )
                        }
                        if (stepsExpanded) {
                            HorizontalDivider(color = scheme.outline.copy(alpha = 0.2f))
                            Column(
                                Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                tools.forEach { step ->
                                    NativeStepCard(item = step, onOpenPath = onOpenPath, onOpenUrl = onOpenUrl)
                                }
                            }
                        }
                    }
                }

                // Collapsible Thinking Box (`💭 思考过程`)
                if (thinkingText.isNotBlank()) {
                    Column(
                        Modifier.fillMaxWidth()
                            .background(scheme.primary.copy(alpha = 0.06f), RoundedCornerShape(8.dp))
                            .border(1.dp, scheme.primary.copy(alpha = 0.25f), RoundedCornerShape(8.dp)),
                    ) {
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable { thinkingExpanded = !thinkingExpanded }
                                .padding(horizontal = 10.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                "💭 思考过程",
                                style = PiType.footnote.copy(fontWeight = FontWeight.Medium),
                                color = scheme.primary,
                            )
                            Text(
                                if (thinkingExpanded) "收起 ▴" else "展开 ▾",
                                style = PiType.micro,
                                color = scheme.onSurfaceVariant,
                            )
                        }
                        if (thinkingExpanded) {
                            HorizontalDivider(color = scheme.primary.copy(alpha = 0.18f))
                            SelectionContainer {
                                Text(
                                    thinkingText,
                                    modifier = Modifier.padding(10.dp),
                                    style = PiType.monoMicro,
                                    color = scheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }

                // Follow-ups (`引用追问` / `批注追问`)
                followUps.forEach { followUp ->
                    val kind = if (quoteOrCommentKind(followUp.text) == FollowUpKind.COMMENT) "📝 批注追问" else "💬 引用追问"
                    val summaryText = followUpSummary(followUp.text)
                    Column(
                        Modifier.fillMaxWidth()
                            .background(scheme.tertiaryContainer.copy(alpha = 0.4f), RoundedCornerShape(8.dp))
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(kind, style = PiType.micro.copy(fontWeight = FontWeight.SemiBold), color = scheme.tertiary)
                        Text(summaryText, style = PiType.footnote, color = scheme.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                }

                // Final Reply (`activity-reply-markdown`)
                val latestReply = replies.lastOrNull()
                if (latestReply != null && latestReply.text.isNotBlank()) {
                    val lines = latestReply.text.split('\n')
                    val isLong = lines.size > CARD_REPLY_LINES || latestReply.text.length > CARD_REPLY_CHARS
                    val visibleText = if (isLong && !replyExpanded) {
                        lines.take(CARD_REPLY_LINES).joinToString("\n").take(CARD_REPLY_CHARS) + "\n…"
                    } else {
                        latestReply.text
                    }
                    MarkdownBody(
                        visibleText,
                        onOpenPath = onOpenPath,
                        onOpenUrl = onOpenUrl,
                        style = PiType.body.copy(color = if (latestReply.isError) scheme.error else scheme.onSurface),
                    )
                    if (isLong) {
                        MetaAction(
                            text = if (replyExpanded) "收起长回复" else "展开完整回复（${lines.size} 行）",
                            onClick = { replyExpanded = !replyExpanded },
                        )
                    }
                } else if (status.running) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PulsingDot(scheme.primary)
                        Text("${status.label}…", style = PiType.footnote, color = scheme.primary)
                    }
                } else if (tools.isEmpty() && progressNotes.isEmpty()) {
                    MetaText("本轮暂无正文回复")
                }
            }

            HorizontalDivider(color = scheme.outline.copy(alpha = 0.2f))

            // ── 3. Activity Footer ──
            Row(
                Modifier.fillMaxWidth()
                    .background(scheme.surfaceVariant.copy(alpha = 0.35f))
                    .clickable(onClick = onOpen)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Surface(
                    color = when {
                        status.failed -> scheme.errorContainer
                        status.running -> scheme.primary.copy(alpha = 0.14f)
                        else -> scheme.secondaryContainer
                    },
                    shape = RoundedCornerShape(99.dp),
                ) {
                    Row(
                        Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        if (accent != null) {
                            if (status.running) PulsingDot(accent) else StatusDot(accent, size = 6.dp)
                        } else {
                            Text("✓", style = PiType.micro.copy(fontWeight = FontWeight.Bold), color = scheme.primary)
                        }
                        Text(
                            status.label,
                            style = PiType.micro.copy(fontWeight = FontWeight.SemiBold),
                            color = when {
                                status.failed -> scheme.onErrorContainer
                                status.running -> scheme.primary
                                else -> scheme.onSecondaryContainer
                            },
                        )
                    }
                }
                Text(
                    "查看详情 / 引用 / 分叉 ▸",
                    style = PiType.micro.copy(fontWeight = FontWeight.Medium),
                    color = scheme.primary,
                )
            }
        }
    }
}

/** A dot that breathes while work is happening — the only motion in the app. */
@Composable
private fun PulsingDot(color: androidx.compose.ui.graphics.Color) {
    val transition = rememberInfiniteTransition(label = "activity")
    val alpha by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.35f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "alpha",
    )
    Box(Modifier.alpha(alpha)) { StatusDot(color, size = 6.dp) }
}
