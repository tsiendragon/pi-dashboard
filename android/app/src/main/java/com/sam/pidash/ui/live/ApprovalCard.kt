package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints

/**
 * The in-conversation approval card.
 *
 * Replaces the old auto-popup: an agent that stops to ask no longer steals the screen or
 * the keyboard, but the request stays visible right above the composer until it is
 * answered. Sudo still opens the secure dialog — a password never gets typed into a card.
 */
@Composable
internal fun ApprovalCard(
    method: String,
    title: String,
    message: String?,
    pendingCount: Int,
    busy: Boolean,
    error: String?,
    onAllow: () -> Unit,
    onDeny: () -> Unit,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val confirm = method == "confirm"
    Column(
        modifier.fillMaxWidth()
            .background(scheme.primary.copy(alpha = Tints.Tint), Radii.card)
            .border(1.dp, scheme.primary.copy(alpha = Tints.TintSoft), Radii.card)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm + Spacing.xxs),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "需要你处理",
                modifier = Modifier.weight(1f),
                style = PiType.caption.copy(fontWeight = FontWeight.SemiBold),
                color = scheme.primary,
            )
            if (pendingCount > 1) Text(
                "还有 ${pendingCount - 1} 个",
                style = PiType.caption,
                color = scheme.onSurfaceVariant,
            )
        }
        Text(
            title.ifBlank { "扩展请求" },
            style = PiType.body.copy(fontWeight = FontWeight.SemiBold),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        message?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = PiType.caption, color = scheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        error?.let { Text(it, style = PiType.caption, color = scheme.error, maxLines = 2) }
        Row(
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // A 34 dp pill inside a 48 dp tap area: prominent without turning the card
            // into a stack of containers.
            Box(
                Modifier.height(48.dp).clip(CircleShape)
                    .clickable(enabled = !busy, role = Role.Button, onClick = if (confirm) onAllow else onOpen)
                    .padding(horizontal = Spacing.xs),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier.height(34.dp).widthIn(min = 72.dp).clip(CircleShape)
                        .background(if (busy) scheme.primary.copy(alpha = Tints.Separator) else scheme.primary)
                        .padding(horizontal = Spacing.md),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        when {
                            confirm -> "允许"
                            method == "sudo" -> "查看授权"
                            else -> "去回答"
                        },
                        style = PiType.action.copy(fontWeight = FontWeight.SemiBold),
                        color = scheme.onPrimary,
                        maxLines = 1,
                    )
                }
            }
            if (confirm) TextButton(onClick = onDeny, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("拒绝", style = PiType.action)
            }
        }
    }
}