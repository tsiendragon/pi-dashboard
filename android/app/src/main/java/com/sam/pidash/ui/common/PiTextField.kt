package com.sam.pidash.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints

/**
 * The app's only text field: filled, 14 dp card radius, hairline border, label above the box.
 * Replaces Material's outlined floating-label fields so dialogs, settings and the composer
 * share one shape instead of three.
 */
@Composable
internal fun PiTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 6,
    isPassword: Boolean = false,
    supportingText: String? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        if (label != null) Text(label, style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = Radii.card,
            color = MaterialTheme.colorScheme.surfaceVariant,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = Tints.Border)),
        ) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .padding(horizontal = Spacing.sm + Spacing.xs, vertical = if (singleLine) 0.dp else Spacing.sm),
                verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    modifier = Modifier.weight(1f).padding(vertical = if (singleLine) 12.dp else 0.dp),
                    enabled = enabled,
                    singleLine = singleLine,
                    minLines = minLines,
                    maxLines = maxLines,
                    textStyle = PiType.body.copy(
                        color = if (enabled) MaterialTheme.colorScheme.onSurface
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    visualTransformation = if (isPassword) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (isPassword) KeyboardType.Password else KeyboardType.Text,
                        autoCorrectEnabled = !isPassword,
                    ),
                    decorationBox = { innerTextField ->
                        Box {
                            if (value.isEmpty() && placeholder != null) Text(
                                placeholder, style = PiType.body,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            innerTextField()
                        }
                    },
                )
                trailing?.invoke()
            }
        }
        if (supportingText != null) Text(
            supportingText, style = PiType.caption,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
