package com.sam.pidash.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

/**
 * The four smallest shared pieces of the visual language.
 *
 * They exist so a status is drawn the same way everywhere: a pill for facts, a dot
 * for state, 11 sp text for actions, and 13 sp semibold for section headers.
 */

@Composable
fun StatusDot(color: Color, size: Dp = 6.dp) {
    Box(Modifier.size(size).background(color, CircleShape))
}

/** A fact: model, status, context usage, tag. Never a control. */
@Composable
fun InfoPill(
    text: String,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    filled: Boolean = true,
) {
    Text(
        text,
        style = PiType.micro,
        color = tint,
        maxLines = 1,
        modifier = Modifier
            .then(
                if (filled) Modifier.background(
                    MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                    Radii.chip,
                ) else Modifier
            )
            .padding(horizontal = Spacing.sm, vertical = 3.dp),
    )
}

/** A quiet action: 11 sp, muted, 6 dp horizontal padding — never a Material button. */
@Composable
fun MetaAction(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color? = null,
) {
    Text(
        text,
        style = PiType.micro,
        color = if (enabled) (tint ?: MaterialTheme.colorScheme.onSurfaceVariant)
        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
        modifier = Modifier
            .clip(Radii.chip)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 3.dp),
    )
}

/** Section heading inside a screen or dialog. */
@Composable
fun SectionLabel(text: String) {
    Text(
        text,
        style = PiType.strong,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 2.dp),
    )
}
