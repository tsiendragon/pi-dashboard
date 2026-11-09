package com.sam.pidash

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.live.BottomRefreshBox
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class BottomRefreshUiTest {
    @get:Rule val compose = createComposeRule()
    private var refreshing by mutableStateOf(false)
    private var enabled by mutableStateOf(true)
    private var viewKey by mutableStateOf(0)
    private var calls = 0
    private lateinit var list: LazyListState
    private fun fixture(atEnd: Boolean = true, empty: Boolean = false, dark: Boolean = false, scale: Float = 1f, initialIndex: Int? = null) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale)) {
                PiDashTheme(darkTheme = dark) { Surface {
                    list = rememberLazyListState()
                    LaunchedEffect(Unit) { if (!empty) list.scrollToItem(initialIndex ?: if (atEnd) 49 else 0) }
                    BottomRefreshBox(refreshing, { empty || !list.canScrollForward }, {
                        calls++; refreshing = true
                    }, Modifier.fillMaxWidth().height(500.dp).testTag("refresh-host"), enabled = enabled, gestureKey = viewKey) {
                        if (empty) Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).heightIn(min = 500.dp), contentAlignment = Alignment.Center) {
                            Text("这段会话还没有消息。")
                        } else LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
                            items((0..49).toList()) { Text("消息 $it · 当前已加载的会话内容", Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(12.dp)) }
                        }
                    }
                } }
            }
        }
        compose.waitForIdle()
    }
    private fun swipe(up: Boolean = true, fraction: Float = 0.65f, duration: Long = 600) {
        compose.onNodeWithTag("refresh-host").performTouchInput {
            val from = if (up) 0.8f else 0.15f
            swipe(Offset(width / 2f, height * from), Offset(width / 2f, height * (from + if (up) -fraction else fraction)), duration)
        }
    }
    private fun holdReady() {
        compose.onNodeWithTag("refresh-host").performTouchInput {
            down(Offset(width / 2f, height * 0.8f))
            moveTo(Offset(width / 2f, height * 0.15f), delayMillis = 600)
        }
        compose.onNodeWithText("松开刷新").assertIsDisplayed()
    }
    private fun lift() { compose.onNodeWithTag("refresh-host").performTouchInput { up() } }

    @Test fun bottomUpRefreshesOnceWithoutMovingAwayFromLatest() {
        fixture(); holdReady()
        compose.runOnIdle { assertEquals(0, calls) }
        lift()
        compose.onNodeWithText("刷新中…").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, calls); assertFalse(list.canScrollForward) }
    }
    @Test fun downwardPullAtTopNoLongerRefreshes() {
        fixture(atEnd = false); swipe(up = false)
        compose.runOnIdle { assertEquals(0, calls) }
    }
    @Test fun scrollingTowardLatestInTheMiddleDoesNotRefresh() {
        fixture(atEnd = false); swipe()
        compose.runOnIdle { assertEquals(0, calls); assertTrue(list.canScrollForward) }
    }
    @Test fun shortOverscrollDoesNotRefresh() {
        fixture(); swipe(fraction = 0.12f)
        compose.runOnIdle { assertEquals(0, calls) }
        compose.onNodeWithText("上拉刷新").assertDoesNotExist()
    }
    @Test fun busyRefreshBlocksRepeatsAndCanBeUsedAgainAfterCompletion() {
        fixture(); swipe(); swipe()
        compose.runOnIdle { assertEquals(1, calls); refreshing = false }
        compose.waitForIdle(); swipe()
        compose.runOnIdle { assertEquals(2, calls) }
    }
    @Test fun disabledGestureDoesNotRefresh() {
        enabled = false; fixture(); swipe()
        compose.runOnIdle { assertEquals(0, calls) }
    }
    @Test fun emptyScrollableStateCanRefresh() {
        fixture(empty = true); swipe()
        compose.runOnIdle { assertEquals(1, calls) }
    }
    @Test fun reversingBeforeReleaseDisarmsRefresh() {
        fixture(); holdReady()
        compose.onNodeWithTag("refresh-host").performTouchInput { moveTo(Offset(width / 2f, height * 0.8f), delayMillis = 600); up() }
        compose.runOnIdle { assertEquals(0, calls) }
    }
    @Test fun changingSessionOrViewDropsThePendingGesture() {
        fixture(); holdReady()
        compose.runOnIdle { viewKey++ }
        compose.waitForIdle(); lift()
        compose.runOnIdle { assertEquals(0, calls) }
    }
    @Test fun inertialArrivalAtBottomDoesNotRefresh() {
        fixture(atEnd = false, initialIndex = 40); swipe(fraction = 0.12f, duration = 48)
        compose.runOnIdle { assertEquals(0, calls); assertFalse(list.canScrollForward) }
    }
    @Test fun readerCanLeaveLatestDuringRefreshWithoutAnOverlayCollisionOrForcedJump() {
        fixture(); swipe(); swipe(up = false)
        compose.runOnIdle { assertEquals(1, calls); assertTrue(list.canScrollForward) }
        val status = compose.onNodeWithText("刷新中…").assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue(status.top < 250.dp)
        compose.runOnIdle { refreshing = false }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(list.canScrollForward) }
    }
    @Test fun readyLightScreenshot() {
        fixture(); holdReady(); compose.onRoot().captureRoboImage("src/test/screenshots/bottom-refresh-light.png"); lift()
    }
    @Test fun readyDarkScreenshot() {
        fixture(dark = true); holdReady(); compose.onRoot().captureRoboImage("src/test/screenshots/bottom-refresh-dark.png"); lift()
    }
    @Test fun readyLargeFontScreenshot() {
        fixture(scale = 2f); holdReady(); compose.onRoot().captureRoboImage("src/test/screenshots/bottom-refresh-large-font.png"); lift()
    }
    @Test @Config(qualifiers = "w600dp-h800dp-xhdpi") fun readyWideScreenshot() {
        fixture(); holdReady(); compose.onRoot().captureRoboImage("src/test/screenshots/bottom-refresh-wide.png"); lift()
    }
}
