package com.sam.pidash.ui.live

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.remote.activityReplies
import com.sam.pidash.data.remote.activityTools
import com.sam.pidash.domain.model.LiveActivity
import com.sam.pidash.domain.model.activityPreview
import com.sam.pidash.domain.model.activityStatus
import com.sam.pidash.ui.common.MetaText
import com.sam.pidash.ui.common.StatusDot
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

/**
 * One turn = one card, a few lines long, tappable for the full record.
 *
 * The card answers three questions at a glance: what did I ask, what is the agent
 * doing right now, and what did it answer. Everything else waits behind the tap.
 */
@Composable
internal fun NativeActivityCard(
    activity: LiveActivity,
    onOpen: () -> Unit,
) {
    val status = activityStatus(activity)
    val prompt = activity.items.firstOrNull { it.role == "user" }?.text?.trim().orEmpty()
    val preview = activityReplies(activity).lastOrNull()?.text?.let { activityPreview(it, maxLines = 3) }.orEmpty()
    val steps = activityTools(activity).size
    val accent = when {
        status.failed -> MaterialTheme.colorScheme.error
        status.running -> MaterialTheme.colorScheme.primary
        else -> null
    }

    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, Radii.card)
            .clickable(onClick = onOpen)
            .padding(horizontal = Spacing.lg, vertical = Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (accent != null) {
                PulsingDot(accent)
                Spacer(Modifier.size(Spacing.sm))
            }
            Text(
                status.label,
                style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                color = accent ?: MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.weight(1f))
            if (steps > 0) MetaText("$steps 步")
        }
        if (prompt.isNotBlank()) {
            Text(
                prompt.replace('\n', ' '),
                style = PiType.footnote,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (preview.isNotBlank()) {
            Text(preview, style = PiType.callout, maxLines = 3, overflow = TextOverflow.Ellipsis)
        } else if (!status.running) {
            MetaText("这一轮没有正文回复")
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
