package com.sam.pidash.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Design tokens for PiDash.
 *
 * The app used Material 3 defaults plus Android's wallpaper-derived dynamic colour,
 * which made a phone screenshot depend on the wallpaper and left every label at the
 * same size. These tokens replace that: one accent, neutral surfaces, a real type
 * scale, and a 4 dp spacing grid.
 *
 * Deliberately small — a screen should only need background/surface/surfaceVariant,
 * the accent, the three text colours and the semantic colours.
 */
object PiPalette {
    // Light
    val LightBackground = Color(0xFFFFFFFF)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSurfaceVariant = Color(0xFFF4F6F8)
    val LightOutline = Color(0xFFE2E6EB)
    val LightOnSurface = Color(0xFF14161A)
    val LightOnSurfaceVariant = Color(0xFF5B6472)
    val LightAccent = Color(0xFF1F6FEB)
    val LightAccentContainer = Color(0xFFE8F1FF)
    val LightSuccess = Color(0xFF1A7F5A)
    val LightError = Color(0xFFD93A3A)

    // Dark
    val DarkBackground = Color(0xFF0F1115)
    val DarkSurface = Color(0xFF15181E)
    val DarkSurfaceVariant = Color(0xFF1C2027)
    val DarkOutline = Color(0xFF2A3038)
    val DarkOnSurface = Color(0xFFE6E8EC)
    val DarkOnSurfaceVariant = Color(0xFF9AA3B0)
    val DarkAccent = Color(0xFF6FA8FF)
    val DarkAccentContainer = Color(0xFF17253A)
    val DarkSuccess = Color(0xFF4ECB9A)
    val DarkError = Color(0xFFFF7A7A)
}

/** 4 dp grid; anything not on it is a bug, not a preference. */
object Spacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
}

object Radii {
    val chip = RoundedCornerShape(6.dp)
    val card = RoundedCornerShape(12.dp)
    val bubble = RoundedCornerShape(16.dp)
}

/** Reading width for prose; phones ignore it, tablets and foldables stop stretching. */
val ProseMaxWidth = 720.dp

/**
 * Type scale. `bodyLarge` is the transcript default (15 sp / 23 sp line height reads
 * well for both Latin and CJK); `bodySmall`+`labelSmall` are for metadata only so a
 * long session keeps a visible hierarchy.
 */
object PiType {
    val body = TextStyle(fontSize = 15.sp, lineHeight = 23.sp)
    val bodyCompact = TextStyle(fontSize = 14.sp, lineHeight = 21.sp)
    val meta = TextStyle(fontSize = 13.sp, lineHeight = 19.sp)
    val micro = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, letterSpacing = 0.2.sp)
    val title = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
    val strong = TextStyle(fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.SemiBold)
    val mono = TextStyle(fontSize = 13.sp, lineHeight = 20.sp, fontFamily = FontFamily.Monospace)
    val monoMicro = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace)
}
