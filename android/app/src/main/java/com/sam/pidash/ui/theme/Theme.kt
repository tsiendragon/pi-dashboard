package com.sam.pidash.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * PiDash keeps its own palette so a screenshot looks the same on every phone.
 *
 * Material's wallpaper-derived dynamic colour is still available, but it is opt-in
 * (`useDynamicColor`): with it on, the user's bubble and every chip change hue per
 * device and contrast is out of our hands.
 */
private val LightColors = lightColorScheme(
    primary = PiPalette.LightAccent,
    onPrimary = androidx.compose.ui.graphics.Color.White,
    primaryContainer = PiPalette.LightAccentContainer,
    onPrimaryContainer = PiPalette.LightOnSurface,
    secondary = PiPalette.LightSuccess,
    tertiary = PiPalette.LightSuccess,
    background = PiPalette.LightBackground,
    onBackground = PiPalette.LightOnSurface,
    surface = PiPalette.LightSurface,
    onSurface = PiPalette.LightOnSurface,
    surfaceVariant = PiPalette.LightSurfaceVariant,
    onSurfaceVariant = PiPalette.LightOnSurfaceVariant,
    outline = PiPalette.LightOutline,
    outlineVariant = PiPalette.LightOutline,
    error = PiPalette.LightError,
    errorContainer = androidx.compose.ui.graphics.Color(0xFFFFF0F0),
    onErrorContainer = PiPalette.LightError,
)

private val DarkColors = darkColorScheme(
    primary = PiPalette.DarkAccent,
    onPrimary = androidx.compose.ui.graphics.Color(0xFF08111F),
    primaryContainer = PiPalette.DarkAccentContainer,
    onPrimaryContainer = PiPalette.DarkOnSurface,
    secondary = PiPalette.DarkSuccess,
    tertiary = PiPalette.DarkSuccess,
    background = PiPalette.DarkBackground,
    onBackground = PiPalette.DarkOnSurface,
    surface = PiPalette.DarkSurface,
    onSurface = PiPalette.DarkOnSurface,
    surfaceVariant = PiPalette.DarkSurfaceVariant,
    onSurfaceVariant = PiPalette.DarkOnSurfaceVariant,
    outline = PiPalette.DarkOutline,
    outlineVariant = PiPalette.DarkOutline,
    error = PiPalette.DarkError,
    errorContainer = androidx.compose.ui.graphics.Color(0xFF2A1416),
    onErrorContainer = PiPalette.DarkError,
)

private val PiTypography = Typography(
    bodyLarge = PiType.body,
    bodyMedium = PiType.bodyCompact,
    bodySmall = PiType.meta,
    labelLarge = PiType.strong,
    labelMedium = PiType.micro,
    labelSmall = PiType.micro,
    titleSmall = PiType.title,
    titleMedium = PiType.title,
    titleLarge = PiType.title,
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
    MaterialTheme(colorScheme = colorScheme, typography = PiTypography, content = content)
}
