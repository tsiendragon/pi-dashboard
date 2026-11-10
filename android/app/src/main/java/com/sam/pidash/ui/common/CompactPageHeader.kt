package com.sam.pidash.ui.common

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing

/** Compact visible chrome, without reducing the 48 dp action targets or swallowing status-bar insets. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CompactPageHeader(
    title: String,
    navigationIcon: (@Composable () -> Unit)? = null,
    subtitle: String? = null,
    actions: @Composable RowScope.() -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(
            Modifier.fillMaxWidth().windowInsetsPadding(TopAppBarDefaults.windowInsets)
                .heightIn(min = 48.dp).padding(horizontal = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            navigationIcon?.invoke()
            Column(Modifier.weight(1f).padding(horizontal = Spacing.sm)) {
                Text(title, style = PiType.pageTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (subtitle != null) Text(
                    subtitle, style = PiType.caption, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            actions()
        }
    }
}

@Composable
internal fun CompactHeaderAction(icon: ImageVector, description: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) {
        Icon(icon, description, Modifier.size(20.dp))
    }
}

/** One discoverable primary action, not a duplicate header action plus a heavily elevated FAB. */
@Composable
internal fun PrimaryCreateAction(text: String, onClick: () -> Unit) {
    ExtendedFloatingActionButton(
        onClick = onClick,
        modifier = Modifier.semantics { contentDescription = text },
        text = { Text(text, style = PiType.footnote.copy(fontWeight = FontWeight.SemiBold)) },
        icon = { Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(20.dp)) },
        shape = Radii.sheet,
        containerColor = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        elevation = FloatingActionButtonDefaults.elevation(
            defaultElevation = 0.dp, pressedElevation = 2.dp, focusedElevation = 1.dp, hoveredElevation = 1.dp,
        ),
    )
}
