package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints

/**
 * The message field as one rounded pill: attach and send live *inside* the container instead of
 * floating beside it (the ChatGPT composer shape). The caller owns every action; this only draws
 * the shell, so it stays testable without a live session.
 */
@Composable
internal fun ComposerPill(
    draft: String,
    onDraftChange: (String) -> Unit,
    enabled: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    onFocusChange: (Boolean) -> Unit,
    maxHeight: Dp,
    modifier: Modifier = Modifier,
    placeholder: String = "输入消息…",
    trailing: (@Composable () -> Unit)? = null,
    leading: @Composable () -> Unit = {},
) {
    Row(
        modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(24.dp))
            // A hairline keeps the pill visible on the near-black dark surface without a shadow.
            .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = Tints.Border), RoundedCornerShape(24.dp))
            .padding(horizontal = 2.dp, vertical = 2.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        leading()
        // The field keeps the same 44 dp height as the buttons so a single line is vertically
        // centred; growing text expands upward while the buttons stay on the bottom edge.
        Box(Modifier.weight(1f).heightIn(min = 44.dp), contentAlignment = Alignment.CenterStart) {
        BasicTextField(
            value = draft,
            onValueChange = onDraftChange,
            modifier = Modifier.fillMaxWidth()
                .heightIn(max = maxHeight)
                .onFocusChanged { onFocusChange(it.isFocused) }
                .testTag("composer-field"),
            textStyle = PiType.userMessage.copy(
                color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            ),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            maxLines = 8,
            enabled = enabled,
            decorationBox = { innerTextField ->
                Box(Modifier.fillMaxWidth()) {
                    if (draft.isEmpty()) Text(
                        placeholder, style = PiType.userMessage,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    innerTextField()
                }
            },
        )
        }
        if (trailing != null) trailing()
        else IconButton(enabled = canSend, onClick = onSend, modifier = Modifier.size(44.dp).testTag("composer-send")) {
            Box(
                Modifier.size(34.dp).background(
                    if (canSend) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f),
                    CircleShape,
                ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Send, "发送", Modifier.size(16.dp),
                    tint = if (canSend) MaterialTheme.colorScheme.onPrimary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}