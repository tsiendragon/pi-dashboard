package com.sam.pidash.ui.live

import androidx.compose.foundation.Canvas
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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sam.pidash.domain.model.VoiceInputPhase
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
    onAbort: (() -> Unit)? = null,
    abortEnabled: Boolean = true,
    aborting: Boolean = false,
    voicePhase: VoiceInputPhase = VoiceInputPhase.Idle,
    voiceInterim: String = "",
    onVoice: (() -> Unit)? = null,
    voiceEnabled: Boolean = true,
    leading: @Composable () -> Unit = {},
) {
    val voicePlaceholder = when (voicePhase) {
        VoiceInputPhase.Connecting -> "正在连接语音识别…"
        VoiceInputPhase.Listening -> voiceInterim.ifBlank { "正在录音；说完点停止…" }
        VoiceInputPhase.Transcribing -> "正在整理语音文字…"
        VoiceInputPhase.Idle -> placeholder
    }
    val voiceDescription = when (voicePhase) {
        VoiceInputPhase.Idle -> "开始语音输入"
        VoiceInputPhase.Connecting -> "正在连接语音识别，点击取消"
        VoiceInputPhase.Listening -> "停止录音并识别"
        VoiceInputPhase.Transcribing -> "正在整理语音文字"
    }
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
                        voicePlaceholder, style = PiType.userMessage,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    innerTextField()
                }
            },
        )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            if (onVoice != null) IconButton(
                enabled = voiceEnabled && voicePhase != VoiceInputPhase.Transcribing,
                onClick = onVoice,
                modifier = Modifier.size(44.dp).testTag("composer-voice")
                    .semantics { contentDescription = voiceDescription },
            ) {
                when (voicePhase) {
                    VoiceInputPhase.Connecting, VoiceInputPhase.Transcribing -> CircularProgressIndicator(
                        modifier = Modifier.size(14.dp), strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    VoiceInputPhase.Listening -> Box(
                        Modifier.size(34.dp).background(MaterialTheme.colorScheme.errorContainer, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(9.dp).background(MaterialTheme.colorScheme.error, RoundedCornerShape(2.dp)))
                    }
                    VoiceInputPhase.Idle -> MicGlyph(MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (onAbort != null) IconButton(
                enabled = abortEnabled && !aborting,
                onClick = onAbort,
                modifier = Modifier.size(44.dp).testTag("composer-abort"),
            ) {
                Box(
                    Modifier.size(34.dp).background(MaterialTheme.colorScheme.errorContainer, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (aborting) CircularProgressIndicator(
                        modifier = Modifier.size(14.dp), strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    ) else Icon(
                        Icons.Filled.Close, "中止当前回合", Modifier.size(17.dp),
                        tint = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
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
}

/** Material's core icon set has no microphone; this keeps the dependency list unchanged. */
@Composable
private fun MicGlyph(tint: Color) {
    Canvas(Modifier.size(18.dp)) {
        val width = size.width
        val height = size.height
        val stroke = Stroke(width = width * 0.085f, cap = StrokeCap.Round)
        drawRoundRect(
            color = tint,
            topLeft = Offset(width * 0.36f, height * 0.08f),
            size = Size(width * 0.28f, height * 0.47f),
            cornerRadius = CornerRadius(width * 0.14f, height * 0.14f),
        )
        drawArc(
            color = tint,
            startAngle = 0f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = Offset(width * 0.22f, height * 0.24f),
            size = Size(width * 0.56f, height * 0.46f),
            style = stroke,
        )
        drawLine(
            color = tint,
            start = Offset(width * 0.5f, height * 0.70f),
            end = Offset(width * 0.5f, height * 0.84f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = tint,
            start = Offset(width * 0.35f, height * 0.86f),
            end = Offset(width * 0.65f, height * 0.86f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
    }
}
