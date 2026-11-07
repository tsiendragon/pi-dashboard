package com.sam.pidash.ui.common

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.Hairline
import com.sam.pidash.ui.theme.Tints
import com.sam.pidash.ui.theme.Motion
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

/**
 * Minimal language: hierarchy comes from size, weight and opacity — never from boxes.
 *
 * There are no pill backgrounds, no chip borders and almost no dividers. A fact is a
 * muted line, a state is one 5 dp dot (or nothing when nothing is happening), and an
 * action is 11 sp text with no container.
 */

/** Only drawn when something is actually happening: running, failed, or selected. */
@Composable
fun StatusDot(color: Color, size: Dp = 5.dp) {
    Box(Modifier.size(size).background(color, CircleShape))
}

/** A muted fact. No background, no border — one line of 12 sp secondary text. */
@Composable
fun MetaText(text: String, tint: Color? = null, maxLines: Int = 1) {
    Text(
        text,
        style = PiType.micro,
        color = tint ?: MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = maxLines,
    )
}

/**
 * Facts joined by a middle dot: `running · dashscope/deepseek · 4.2%`.
 * One line beats four boxes when every value is the same kind of information.
 */
@Composable
fun MetaLine(parts: List<String>, tint: Color? = null, maxLines: Int = 1) {
    if (parts.isEmpty()) return
    Text(
        parts.joinToString("  ·  "),
        style = PiType.micro,
        color = tint ?: MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = maxLines,
    )
}

/** A quiet action with a minimum 48 dp touch target. */
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
        else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
        modifier = Modifier
            .clip(Radii.chip)
            .clickable(enabled = enabled, onClick = onClick)
            .widthIn(min = 48.dp)
            .heightIn(min = 48.dp)
            .wrapContentHeight(Alignment.CenterVertically)
            .padding(horizontal = Spacing.sm),
    )
}

/**
 * An iOS hairline: 0.5 dp, inset 16 dp from the leading edge (or full width when the
 * row already has its own inset). Never use a 1 dp rule.
 */
@Composable
fun InsetSeparator(modifier: Modifier = Modifier, inset: Dp = Spacing.lg) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(start = inset)
            .height(Hairline)
            .background(MaterialTheme.colorScheme.outline.copy(alpha = Tints.Separator)),
    )
}

/** The same quiet border, surface and radius as the main Live activity cards. */
@Composable
fun GroupedCard(modifier: Modifier = Modifier, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    androidx.compose.material3.Surface(
        modifier = modifier.fillMaxWidth(), shape = Radii.card,
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = Tints.Border)),
        tonalElevation = 1.dp,
    ) {
        Column(content = content)
    }
}

/** Section heading: 12 sp semibold, muted, no rule under it. */
@Composable
fun SectionLabel(text: String) {
    Text(
        text,
        style = PiType.strong,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 2.dp),
    )
}

/**
 * "展开 / 收起" affordance used by every collapsible block.
 *
 * One component instead of a text glyph: the chevron keeps its optical size and baseline
 * in any font, and the label never drifts a pixel per call site.
 */
@Composable
fun ExpandHint(
    expanded: Boolean,
    modifier: Modifier = Modifier,
    collapsedLabel: String = "展开",
    expandedLabel: String = "收起",
) {
    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            if (expanded) expandedLabel else collapsedLabel,
            style = PiType.micro,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
        Icon(
            imageVector = if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Icon-free row used by lists: content on the left, one muted action on the right. */
@Composable
fun TextRow(
    content: @Composable () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = Spacing.lg, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) { content() }
        trailing?.invoke()
    }
}

/**
 * A block that grows and fades instead of snapping into place.
 *
 * Every collapsible surface in the app goes through this one composable so the whole app
 * shares a single expand rhythm; [animateContentSize] on the parent keeps the surrounding
 * card from jumping when the child swaps content.
 */
@Composable
fun Collapsible(
    visible: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable AnimatedVisibilityScope.() -> Unit,
) {
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = expandVertically(Motion.content()) + fadeIn(Motion.fast()),
        exit = shrinkVertically(Motion.content()) + fadeOut(Motion.fast()),
        content = content,
    )
}
