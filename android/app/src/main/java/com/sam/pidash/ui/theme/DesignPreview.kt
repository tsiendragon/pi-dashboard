package com.sam.pidash.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.common.ExpandHint

/**
 * The design system on one screen, for Android Studio's preview pane.
 *
 * It is not shipped UI: it exists so a change to a token is reviewed against every surface
 * that consumes it (type scale, label opacities, status colours, radii) instead of being
 * checked through three different screens.
 */
@Preview(name = "Type scale", widthDp = 360, heightDp = 640, showBackground = true)
@Composable
private fun TypeScalePreview() {
    PiDashTheme {
        Surface(color = MaterialTheme.colorScheme.background) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(
                    "largeTitle" to PiType.largeTitle,
                    "title" to PiType.title,
                    "headline" to PiType.headline,
                    "body" to PiType.body,
                    "callout" to PiType.callout,
                    "footnote" to PiType.footnote,
                    "caption" to PiType.caption,
                    "action" to PiType.action,
                    "mono" to PiType.mono,
                    "monoMicro" to PiType.monoMicro,
                ).forEach { (name, style) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(name, Modifier.width(88.dp), style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("会话 finnote 1234 · 12.5%", style = style)
                    }
                }
                HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outline)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("展开提示：", style = PiType.caption)
                    ExpandHint(expanded = false)
                    ExpandHint(expanded = true)
                }
            }
        }
    }
}

@Preview(name = "Colour roles", widthDp = 360, heightDp = 520, showBackground = true)
@Composable
private fun ColourRolesPreview() {
    PiDashTheme {
        val scheme = MaterialTheme.colorScheme
        Surface(color = scheme.background) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(
                    "primary" to scheme.primary,
                    "secondary" to scheme.secondary,
                    "tertiary" to scheme.tertiary,
                    "error" to scheme.error,
                    "outline" to scheme.outline,
                    "surfaceVariant" to scheme.surfaceVariant,
                ).forEach { (name, color) ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Surface(color = color, shape = RoundedCornerShape(4.dp), modifier = Modifier.size(width = 56.dp, height = 20.dp)) {}
                        Text(name, style = PiType.caption)
                    }
                }
                HorizontalDivider(Modifier.padding(vertical = 4.dp), color = scheme.outline)
                Text("代码高亮", style = PiType.caption, color = scheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth().background(scheme.surfaceVariant.copy(alpha = 0.5f), Radii.chip).padding(8.dp)) {
                    val palette = CodeColors.of(false)
                    listOf("kw" to palette.keyword, "str" to palette.string, "num" to palette.number,
                        "type" to palette.type, "fn" to palette.function, "cmt" to palette.comment).forEach { (label, color) ->
                        Text(" $label ", style = PiType.monoMicro, color = color)
                    }
                }
            }
        }
    }
}
