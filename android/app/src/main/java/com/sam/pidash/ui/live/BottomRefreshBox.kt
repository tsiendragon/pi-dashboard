package com.sam.pidash.ui.live

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import com.sam.pidash.ui.theme.PiType
import kotlin.math.min

/** Only unconsumed finger motion at the latest edge belongs to refresh; never a fling. */
internal class BottomRefreshGesture(private val thresholdPx: Float) {
    init { require(thresholdPx.isFinite() && thresholdPx > 0f) }
    var distancePx by mutableFloatStateOf(0f)
        private set
    val progress: Float get() = (distancePx / thresholdPx).coerceIn(0f, 1f)
    val ready: Boolean get() = distancePx >= thresholdPx
    fun pull(availableY: Float): Float {
        if (!availableY.isFinite() || availableY >= 0f) return 0f
        // Cap only the displayed progress, not consumed travel: reversing must not scroll
        // history before the finger has undone its overscroll.
        distancePx = (distancePx - availableY).coerceAtMost(Float.MAX_VALUE)
        return availableY
    }
    fun retract(availableY: Float): Float {
        if (!availableY.isFinite() || availableY <= 0f) return 0f
        val used = min(availableY, distancePx)
        distancePx -= used
        return used
    }
    fun reset() { distancePx = 0f }
    fun release(allowed: Boolean): Boolean {
        val refresh = allowed && ready
        reset()
        return refresh
    }
}

/** Bottom overlay does not translate the transcript, change its keys, or reverse text/selection. */
@Composable
internal fun BottomRefreshBox(
    isRefreshing: Boolean,
    atBottom: () -> Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    gestureKey: Any? = Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    val threshold = with(LocalDensity.current) { 96.dp.toPx() }
    val gesture = remember(gestureKey, threshold) { BottomRefreshGesture(threshold) }
    var requested by remember(gestureKey) { mutableStateOf(false) }
    val currentBottom by rememberUpdatedState(atBottom)
    val currentRefresh by rememberUpdatedState(onRefresh)
    val currentEnabled by rememberUpdatedState(enabled)
    val refreshing by rememberUpdatedState(isRefreshing)
    val end = atBottom()
    DisposableEffect(gesture) { onDispose { gesture.reset() } }
    LaunchedEffect(isRefreshing, gesture) {
        if (!isRefreshing) requested = false else gesture.reset()
    }
    LaunchedEffect(enabled, end, gesture) { if (!enabled || !end) gesture.reset() }
    val connection = remember(gesture) {
        object : NestedScrollConnection {
            fun allowed() = currentEnabled && currentBottom() && !refreshing && !requested
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (!allowed()) { gesture.reset(); return Offset.Zero }
                return if (source == NestedScrollSource.UserInput) Offset(0f, gesture.retract(available.y)) else Offset.Zero
            }
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (!allowed()) { gesture.reset(); return Offset.Zero }
                return if (source == NestedScrollSource.UserInput) Offset(0f, gesture.pull(available.y)) else Offset.Zero
            }
            override suspend fun onPreFling(available: Velocity): Velocity {
                val hadPull = gesture.distancePx > 0f
                if (gesture.release(allowed())) {
                    requested = true
                    currentRefresh()
                }
                return if (hadPull) Velocity(0f, available.y) else Velocity.Zero
            }
        }
    }
    Box(modifier.nestedScroll(connection)) {
        content()
        if (isRefreshing || gesture.distancePx > 0f) {
            // Drawing-only overlay: no pointer handler to steal scrolling or text selection.
            Row(
                Modifier.align(if (isRefreshing && !end) Alignment.TopCenter else Alignment.BottomCenter).padding(8.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.medium)
                    .border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), MaterialTheme.shapes.medium)
                    .semantics { liveRegion = LiveRegionMode.Polite }
                    .padding(horizontal = 12.dp, vertical = 8.dp).heightIn(min = 32.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                if (isRefreshing) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                else CircularProgressIndicator(progress = { gesture.progress }, modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Text(if (isRefreshing) "刷新中…" else if (gesture.ready) "松开刷新" else "上拉刷新",
                    style = PiType.caption, color = MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}
