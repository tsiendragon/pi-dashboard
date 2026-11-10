package com.sam.pidash.ui.live

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.common.ExpandHint
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Tints

/**
 * One collapsed block for "what the agent did" and "what it thought about".
 *
 * The activity feed, the activity card and the full-record page all draw this same header:
 * same radius, padding, pill and chevron, so a step block never looks like a different
 * product on each screen. Only [accent] changes — thinking reads in the primary colour,
 * execution stays neutral. Failures are pills, never a second border colour or bare red text.
 */
internal enum class TraceTone { NEUTRAL, RUNNING, ERROR }

internal data class TraceState(val text: String, val tone: TraceTone = TraceTone.NEUTRAL)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TraceBlock(
    title: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    counts: String? = null,
    states: List<TraceState> = emptyList(),
    accent: Color? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val scheme = MaterialTheme.colorScheme
    val line = accent?.copy(alpha = Tints.TintSoft) ?: scheme.outline.copy(alpha = Tints.Border)
    Column(
        modifier.fillMaxWidth()
            .background(accent?.copy(alpha = Tints.Tint) ?: scheme.surfaceVariant.copy(alpha = Tints.Block), Radii.chip)
            .border(1.dp, line, Radii.chip),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .clickable(onClick = onToggle)
                .heightIn(min = 48.dp)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FlowRow(
                modifier = Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    title,
                    modifier = Modifier.align(Alignment.CenterVertically),
                    style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                    color = accent ?: scheme.onSurface,
                )
                if (!counts.isNullOrBlank()) {
                    StatPill(counts, modifier = Modifier.align(Alignment.CenterVertically))
                }
                states.forEach { state ->
                    StatPill(state.text, state.tone, Modifier.align(Alignment.CenterVertically))
                }
            }
            ExpandHint(expanded)
        }
        androidx.compose.animation.AnimatedVisibility(visible = expanded) {
            Column(Modifier.fillMaxWidth()) {
                HorizontalDivider(color = line)
                content()
            }
        }
    }
}

/** Compact count/state pill shared by every trace header: 99 dp shape, 1 dp vertical padding. */
@Composable
internal fun StatPill(text: String, tone: TraceTone = TraceTone.NEUTRAL, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val (background, foreground) = when (tone) {
        TraceTone.ERROR -> scheme.errorContainer to scheme.onErrorContainer
        TraceTone.RUNNING -> scheme.primary.copy(alpha = Tints.TintSoft) to scheme.primary
        TraceTone.NEUTRAL -> scheme.surface to scheme.onSurfaceVariant
    }
    Surface(modifier = modifier, color = background, shape = RoundedCornerShape(99.dp), border = null) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp),
            style = PiType.monoMicro,
            color = foreground,
        )
    }
}