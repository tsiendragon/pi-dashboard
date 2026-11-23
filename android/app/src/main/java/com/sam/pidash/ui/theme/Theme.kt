package com.sam.pidash.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

/**
 * iOS-style colour scheme: pure white / pure black pages, `#F2F2F7` grouped surfaces,
 * label colours expressed as opacity, one system-blue accent.
 *
 * Wallpaper-derived dynamic colour stays available but is off by default — with it on,
 * the accent and every grouped surface change per device.
 */
private val LightColors = lightColorScheme(
    primary = PiPalette.LightAccent,
    onPrimary = Color.White,
    primaryContainer = PiPalette.LightAccent.copy(alpha = 0.12f),
    onPrimaryContainer = PiPalette.LightLabel,
    secondary = PiPalette.LightSuccess,
    secondaryContainer = PiPalette.LightGrouped,
    onSecondaryContainer = PiPalette.LightLabel,
    tertiary = PiPalette.LightSuccess,
    tertiaryContainer = PiPalette.LightGrouped,
    onTertiaryContainer = PiPalette.LightLabel,
    background = PiPalette.LightBackground,
    onBackground = PiPalette.LightLabel,
    surface = PiPalette.LightSurface,
    surfaceContainerLowest = PiPalette.LightSurface,
    surfaceContainerLow = PiPalette.LightSurface,
    surfaceContainer = PiPalette.LightSurface,
    surfaceContainerHigh = PiPalette.LightGrouped,
    surfaceContainerHighest = PiPalette.LightGrouped,
    surfaceTint = Color.Transparent,
    onSurface = PiPalette.LightLabel,
    surfaceVariant = PiPalette.LightGrouped,
    onSurfaceVariant = PiPalette.LightSecondaryLabel,
    outline = PiPalette.LightSeparator,
    outlineVariant = PiPalette.LightSeparator,
    error = PiPalette.LightError,
    errorContainer = PiPalette.LightError.copy(alpha = 0.10f),
    onErrorContainer = PiPalette.LightError,
)

private val DarkColors = darkColorScheme(
    primary = PiPalette.DarkAccent,
    onPrimary = Color.White,
    primaryContainer = PiPalette.DarkAccent.copy(alpha = 0.18f),
    onPrimaryContainer = PiPalette.DarkLabel,
    secondary = PiPalette.DarkSuccess,
    secondaryContainer = PiPalette.DarkGrouped,
    onSecondaryContainer = PiPalette.DarkLabel,
    tertiary = PiPalette.DarkSuccess,
    tertiaryContainer = PiPalette.DarkGrouped,
    onTertiaryContainer = PiPalette.DarkLabel,
    background = PiPalette.DarkBackground,
    onBackground = PiPalette.DarkLabel,
    surface = PiPalette.DarkSurface,
    surfaceContainerLowest = PiPalette.DarkBackground,
    surfaceContainerLow = PiPalette.DarkGrouped,
    surfaceContainer = PiPalette.DarkSurface,
    surfaceContainerHigh = PiPalette.DarkSurface,
    surfaceContainerHighest = PiPalette.DarkSurface,
    surfaceTint = Color.Transparent,
    onSurface = PiPalette.DarkLabel,
    surfaceVariant = PiPalette.DarkGrouped,
    onSurfaceVariant = PiPalette.DarkSecondaryLabel,
    outline = PiPalette.DarkSeparator,
    outlineVariant = PiPalette.DarkSeparator,
    error = PiPalette.DarkError,
    errorContainer = PiPalette.DarkError.copy(alpha = 0.16f),
    onErrorContainer = PiPalette.DarkError,
)

/** One radius family: 8 chips, 14 cards/sheets, 18 bubbles. */
private val PiShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = Radii.card,
    medium = Radii.card,
    large = RoundedCornerShape(14.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

/** Cover every slot: dialogs must not silently inherit Material's unrelated 24 sp headline. */
internal val PiTypography = Typography(
    displayLarge = PiType.largeTitle,
    displayMedium = PiType.title,
    displaySmall = PiType.headline,
    headlineLarge = PiType.title,
    headlineMedium = PiType.headline,
    headlineSmall = PiType.pageTitle,
    titleLarge = PiType.pageTitle,
    titleMedium = PiType.pageTitle,
    titleSmall = PiType.rowTitle,
    bodyLarge = PiType.body,
    bodyMedium = PiType.body,
    bodySmall = PiType.footnote,
    labelLarge = PiType.footnote,
    labelMedium = PiType.footnote,
    labelSmall = PiType.caption,
)

/** Selection must stay legible on the paper-white page instead of disappearing into it. */
internal fun piTextSelectionColors(colorScheme: ColorScheme): TextSelectionColors =
    TextSelectionColors(
        handleColor = colorScheme.primary,
        backgroundColor = colorScheme.primary.copy(alpha = Tints.Block),
    )

@Composable
fun PiDashTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    useDynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }
    val selectionColors = remember(colorScheme.primary) { piTextSelectionColors(colorScheme) }
    MaterialTheme(colorScheme = colorScheme, typography = PiTypography, shapes = PiShapes) {
        // MaterialTheme supplies its own 40% default; pin the app token so a theme change
        // cannot silently make selected prose indistinguishable from its background.
        CompositionLocalProvider(LocalTextSelectionColors provides selectionColors) {
            content()
        }
    }
}
