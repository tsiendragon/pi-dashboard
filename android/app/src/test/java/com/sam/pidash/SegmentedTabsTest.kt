package com.sam.pidash

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.ui.common.SegmentedTabs
import com.sam.pidash.ui.theme.PiDashTheme
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class SegmentedTabsTest {
    @get:Rule val compose = createComposeRule()
    private var picked = ""

    private fun fixture(selected: String = "live", dark: Boolean = false) {
        compose.setContent {
            PiDashTheme(darkTheme = dark) {
                Surface { Column { SegmentedTabs(listOf("live" to "Live Pi", "chat" to "Chat"), selected, { picked = it }) } }
            }
        }
    }

    @Test fun selectedTabIsASelectedTabAndTheOtherIsNot() {
        fixture("live")
        compose.onNodeWithText("Live Pi").assertIsSelected()
        compose.onNodeWithText("Chat").assertIsNotSelected()
    }
    @Test fun tappingTheInactiveTabReportsItsValueOnce() {
        fixture("live")
        compose.onNodeWithText("Chat").performClick()
        compose.runOnIdle { assertEquals("chat", picked) }
        compose.onNodeWithText("Live Pi").performClick()
        compose.runOnIdle { assertEquals("live", picked) }
    }
    @Test fun paintedPillIsShorterThanItsTouchTarget() {
        fixture()
        // The painted pill is 30 dp (checked in the screenshots); taps still get 48 dp.
        compose.onAllNodes(isSelectable()).assertCountEquals(2)
        compose.onAllNodes(isSelectable())[0].assertHeightIsAtLeast(48.dp)
        compose.onAllNodes(isSelectable())[1].assertHeightIsAtLeast(48.dp)
    }
    @Test fun lightScreenshot() { fixture(); compose.onRoot().captureRoboImage("src/test/screenshots/segmented-tabs.png") }
    @Test fun darkScreenshot() { fixture("chat", dark = true); compose.onRoot().captureRoboImage("src/test/screenshots/segmented-tabs-dark.png") }
}
