package com.sam.pidash.ui.common

import android.animation.ValueAnimator
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Android's "Remove animations" accessibility setting turns the global animator scale off. */
internal fun animatorsEnabled(): Boolean = try {
    ValueAnimator.areAnimatorsEnabled()
} catch (_: Throwable) {
    true
}

private const val PULSE_DIM = 0.35f

/** Dim end of the breath; [fraction] 0 is fully opaque, 1 is the most dim. */
internal fun breathingAlpha(animate: Boolean, fraction: Float): Float =
    if (!animate) 1f else 1f + (PULSE_DIM - 1f) * fraction.coerceIn(0f, 1f)

/**
 * One breathing dot for "work is happening now". Motion never carries the state alone:
 * callers keep the running label beside it, and [contentDescription] names it for talkback.
 * Idle/failed/unknown states use the static [StatusDot] instead. When animations are off
 * the dot stays fully opaque so it still marks a running session.
 */
@Composable
fun PulsingDot(
    color: Color,
    size: Dp = 6.dp,
    modifier: Modifier = Modifier,
    animate: Boolean = animatorsEnabled(),
    contentDescription: String? = null,
) {
    val described = if (contentDescription == null) modifier else modifier.semantics {
        this.contentDescription = contentDescription
    }
    val fraction = if (animate) {
        val transition = rememberInfiniteTransition(label = "activity")
        val value by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
            label = "breath",
        )
        value
    } else 0f
    Box(described.size(size).alpha(breathingAlpha(animate, fraction)).background(color, CircleShape))
}