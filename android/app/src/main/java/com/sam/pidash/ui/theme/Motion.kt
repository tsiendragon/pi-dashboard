package com.sam.pidash.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween

/**
 * One motion vocabulary for the whole app.
 *
 * Three durations only: a tick for state feedback (150 ms), a breath for content that
 * grows or collapses (220 ms), and a push for screen changes (260 ms). Anything that
 * needs a fourth duration is usually a design problem, not a timing problem.
 */
object Motion {
    const val FastMs = 150
    const val ContentMs = 220
    const val ScreenMs = 260

    /** Decelerating curve; reads as "settles" rather than "stops". */
    val Standard = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    fun <T> fast(): FiniteAnimationSpec<T> = tween(FastMs, easing = Standard)
    fun <T> content(): FiniteAnimationSpec<T> = tween(ContentMs, easing = Standard)
    fun <T> screen(): FiniteAnimationSpec<T> = tween(ScreenMs, easing = Standard)
}
