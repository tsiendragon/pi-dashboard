package com.sam.pidash.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing

private val TrackHeight = 34.dp
private val PillHeight = 30.dp
private val TabBoxHeight = 48.dp

/**
 * The app's only tab control: a quiet segmented pill used for page-level sections
 * (Live Pi / Chat) and in-session projections (活动 / 完整). The painted track is only
 * 34 dp tall so the label is not lost in empty space; each tab still owns a full
 * 48 dp touch target around it.
 */
@Composable
internal fun SegmentedTabs(
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val track = MaterialTheme.colorScheme.secondaryContainer
    Row(
        modifier.height(TabBoxHeight)
            .drawBehind {
                val h = TrackHeight.toPx()
                drawRoundRect(
                    color = track,
                    topLeft = Offset(0f, (size.height - h) / 2f),
                    size = Size(size.width, h),
                    cornerRadius = CornerRadius(h / 2f),
                )
            }
            .selectableGroup()
            // Tabs start 2 dp inside the track so the selected pill never pokes out of its rounded ends.
            .padding(horizontal = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { (value, label) ->
            val active = value == selected
            Box(
                Modifier.height(TabBoxHeight).widthIn(min = 64.dp)
                    .selectable(selected = active, role = Role.Tab) { onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier.widthIn(min = 64.dp).height(PillHeight)
                        .clip(RoundedCornerShape(percent = 50))
                        .background(if (active) MaterialTheme.colorScheme.surface else Color.Transparent)
                        .padding(horizontal = Spacing.sm + Spacing.xs),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label,
                        style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold),
                        color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}
