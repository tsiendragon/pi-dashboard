package com.sam.pidash.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Design tokens for PiDash — minimal.
 *
 * Rules the palette encodes:
 * 1. Background and surface are the same colour; the app has no elevation.
 * 2. There is one accent, and it is reserved for what the user can act on
 *    (links, primary button, a running state). Nothing decorative is coloured.
 * 3. Everything else is `onSurface` at full, 60% or 40% opacity. No tints, no pills.
 */
object PiPalette {
    val LightBackground = Color(0xFFFFFFFF)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSurfaceVariant = Color(0xFFF6F7F9)
    val LightOutline = Color(0xFFE6E9ED)
    val LightOnSurface = Color(0xFF16181C)
    val LightOnSurfaceVariant = Color(0xFF6B7280)
    val LightAccent = Color(0xFF1F6FEB)
    val LightAccentContainer = Color(0xFFEAF1FE)
    val LightSuccess = Color(0xFF1A7F5A)
    val LightError = Color(0xFFCE3B3B)

    val DarkBackground = Color(0xFF0E1013)
    val DarkSurface = Color(0xFF0E1013)
    val DarkSurfaceVariant = Color(0xFF191C21)
    val DarkOutline = Color(0xFF24282E)
    val DarkOnSurface = Color(0xFFEDEFF2)
    val DarkOnSurfaceVariant = Color(0xFF8E96A2)
    val DarkAccent = Color(0xFF7FB0FF)
    val DarkAccentContainer = Color(0xFF151D2B)
    val DarkSuccess = Color(0xFF57C79A)
    val DarkError = Color(0xFFFF7B7B)
}

/**
 * Spacing is a 4 dp grid, but the vertical rhythm is deliberately generous: minimal
 * design reads as "airy", and cramming rows is what made the old screen feel dense.
 */
object Spacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
}

object Radii {
    val chip = RoundedCornerShape(4.dp)
    val card = RoundedCornerShape(8.dp)
    val bubble = RoundedCornerShape(12.dp)
}

/** Reading width; phones ignore it, tablets stop stretching. */
val ProseMaxWidth = 680.dp

/**
 * Type scale. Only four steps are used on a screen: 15/16 for content, 13 for
 * secondary, 12 for metadata, 11 for actions. Weight carries emphasis, not colour.
 */
object PiType {
    val body = TextStyle(fontSize = 15.sp, lineHeight = 24.sp)
    val bodyCompact = TextStyle(fontSize = 14.sp, lineHeight = 22.sp)
    val meta = TextStyle(fontSize = 13.sp, lineHeight = 20.sp)
    val micro = TextStyle(fontSize = 12.sp, lineHeight = 18.sp)
    val action = TextStyle(fontSize = 11.sp, lineHeight = 16.sp)
    val title = TextStyle(fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold)
    val strong = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold)
    val mono = TextStyle(fontSize = 13.sp, lineHeight = 21.sp, fontFamily = FontFamily.Monospace)
    val monoMicro = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace)
}
