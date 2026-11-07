package com.sam.pidash.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Tokens following Apple's iOS visual language, kept minimal.
 *
 * What makes it read as "iOS" rather than "generic Material":
 * 1. System colours: `#007AFF` accent, grouped background `#F2F2F7` / `#1C1C1E`,
 *    labels at 100 / 60 / 30% instead of dozens of greys.
 * 2. A compact, consistent type scale: 15 sp reading text, 13 sp controls and
 *    secondary information; sizes still follow the system font scale.
 * 3. Hairlines: a 0.5 dp separator, inset 16 dp — Apple never draws a heavy rule.
 * 4. Continuity: one radius family (10 grouped cards, 18 bubbles, 14 sheets) and one
 *    accent used only where the user acts.
 */
object PiPalette {
    // Light — iOS system colours
    val LightBackground = Color(0xFFFFFFFF)
    val LightGrouped = Color(0xFFF2F2F7)
    val LightSurface = Color(0xFFFFFFFF)
    val LightSeparator = Color(0xFFC6C6C8)
    val LightLabel = Color(0xFF000000)
    val LightSecondaryLabel = Color(0x993C3C43)
    val LightTertiaryLabel = Color(0x4D3C3C43)
    val LightAccent = Color(0xFF007AFF)
    val LightSuccess = Color(0xFF34C759)
    val LightError = Color(0xFFFF3B30)

    // Dark — iOS system colours
    val DarkBackground = Color(0xFF000000)
    val DarkGrouped = Color(0xFF1C1C1E)
    val DarkSurface = Color(0xFF2C2C2E)
    val DarkSeparator = Color(0xFF38383A)
    val DarkLabel = Color(0xFFFFFFFF)
    val DarkSecondaryLabel = Color(0x99EBEBF5)
    val DarkTertiaryLabel = Color(0x4DEBEBF5)
    val DarkAccent = Color(0xFF0A84FF)
    val DarkSuccess = Color(0xFF30D158)
    val DarkError = Color(0xFFFF453A)
}

/**
 * The only opacities the UI may apply to a theme colour.
 *
 * Before this existed the code had twenty different alphas — 0.06, 0.09, 0.10, 0.14, 0.16,
 * 0.18 … — which nobody can name and the eye reads as inconsistent. Five steps are enough:
 * a wash, a stronger wash, a filled block, a border and a hairline. Text never multiplies
 * the label colour; `onSurfaceVariant` already carries its opacity.
 */
object Tints {
    const val Tint = 0.10f
    const val TintSoft = 0.16f
    const val Block = 0.45f
    const val Border = 0.35f
    const val Hairline = 0.20f
    const val Separator = 0.60f
}

/** 4 dp grid; margins and section gaps follow iOS rhythm (16 / 24 / 32). */
object Spacing {
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
}

/** Apple's separator weight: a hairline, never a 1 dp rule. */
val Hairline = 0.5.dp

object Radii {
    /** Same 14 dp card silhouette as the main Live activity feed. */
    val card = RoundedCornerShape(14.dp)
    /** Sheet and dialog. */
    val sheet = RoundedCornerShape(14.dp)
    /** Message bubble; the sender's tail corner is tightened at the call site. */
    val bubble = RoundedCornerShape(18.dp)
    val chip = RoundedCornerShape(8.dp)
}

val ProseMaxWidth = 680.dp

/** Shared type scale for readable content and compact application chrome. */
object PiType {
    private val prose = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, letterSpacing = 0.sp)
    val largeTitle = prose.copy(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp)
    val title = prose.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp)
    val headline = prose.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.1).sp)
    val body = prose.copy(fontSize = 15.sp, lineHeight = 22.sp)
    val userMessage = prose.copy(fontSize = 14.sp, lineHeight = 20.sp)
    val callout = body
    val subhead = body
    val footnote = prose.copy(fontSize = 13.sp, lineHeight = 18.sp, fontFeatureSettings = "tnum")
    val caption = prose.copy(fontSize = 12.sp, lineHeight = 16.sp, fontFeatureSettings = "tnum")
    val action = prose.copy(fontSize = 12.sp, lineHeight = 16.sp)
    // Page/dialog chrome follows the main Live session header, not Material's 24 sp default.
    val pageTitle = callout.copy(fontWeight = FontWeight.SemiBold)
    val rowTitle = callout.copy(fontWeight = FontWeight.Medium)
    val mono = TextStyle(fontSize = 13.sp, lineHeight = 20.sp, fontFamily = FontFamily.Monospace)
    val monoMicro = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace)

    // Backwards-compatible aliases used across screens while they migrate.
    val bodyCompact = callout
    val meta = subhead
    val micro = footnote
    val strong = caption.copy(fontWeight = FontWeight.SemiBold)
}
