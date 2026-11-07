package com.sam.pidash.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Syntax colours for fenced code blocks.
 *
 * They live with the rest of the palette so dark/light stay a single decision, and so the
 * markdown renderer has no colour literals of its own. Values follow a muted One Dark /
 * One Light pair: readable on both `#F2F2F7` and `#1C1C1E`.
 */
object CodeColors {
    data class Palette(
        val keyword: Color,
        val string: Color,
        val comment: Color,
        val number: Color,
        val type: Color,
        val function: Color,
    )

    val Light = Palette(
        keyword = Color(0xFF7C3AED),
        string = Color(0xFF047857),
        comment = Color(0xFF6B7280),
        number = Color(0xFFB45309),
        type = Color(0xFF1D4ED8),
        function = Color(0xFF0E7490),
    )

    val Dark = Palette(
        keyword = Color(0xFFC792EA),
        string = Color(0xFFC3E88D),
        comment = Color(0xFF7F8C98),
        number = Color(0xFFF78C6C),
        type = Color(0xFF82AAFF),
        function = Color(0xFF89DDFF),
    )

    fun of(dark: Boolean): Palette = if (dark) Dark else Light
}
