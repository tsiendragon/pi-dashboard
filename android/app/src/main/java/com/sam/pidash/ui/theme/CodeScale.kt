package com.sam.pidash.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle

/**
 * Multiplier for code and tool output only.
 *
 * The app-wide font scale follows the system; code often needs one extra step because
 * monospace glyphs look smaller than prose at the same sp. Provided once at the root so
 * every transcript renderer agrees; 1f keeps the existing golden images unchanged.
 */
val LocalCodeScale = staticCompositionLocalOf { 1f }

@Composable
fun codeTextStyle(base: TextStyle): TextStyle {
    val scale = LocalCodeScale.current
    if (scale == 1f) return base
    return base.copy(fontSize = base.fontSize * scale, lineHeight = base.lineHeight * scale)
}
