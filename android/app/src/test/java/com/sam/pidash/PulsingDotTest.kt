package com.sam.pidash

import android.animation.ValueAnimator
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.ui.common.PulsingDot
import com.sam.pidash.ui.common.animatorsEnabled
import com.sam.pidash.ui.common.breathingAlpha
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class PulsingDotTest {
    @get:Rule val compose = createComposeRule()
    private val scaleField = ValueAnimator::class.java.getDeclaredField("sDurationScale").apply { isAccessible = true }
    private val originalScale = scaleField.getFloat(null)

    @After fun restoreAnimatorScale() { scaleField.setFloat(null, originalScale) }

    @Test fun breathStaysOpaqueWhenAnimationIsOff() {
        assertEquals(1f, breathingAlpha(animate = false, fraction = 0f), 0f)
        assertEquals(1f, breathingAlpha(animate = false, fraction = 0.5f), 0f)
        assertEquals(1f, breathingAlpha(animate = false, fraction = 1f), 0f)
    }
    @Test fun breathMovesBetweenOpaqueAndDimOnlyWhileRunning() {
        assertEquals(1f, breathingAlpha(true, 0f), 0.001f)
        assertEquals(1f, breathingAlpha(true, -5f), 0.001f)
        assertEquals(0.675f, breathingAlpha(true, 0.5f), 0.001f)
        assertEquals(0.35f, breathingAlpha(true, 1f), 0.001f)
        assertEquals(0.35f, breathingAlpha(true, 9f), 0.001f)
    }
    @Test fun systemRemoveAnimationsDisablesBreathing() {
        assertEquals(true, animatorsEnabled())
        scaleField.setFloat(null, 0f)
        assertEquals(false, animatorsEnabled())
        scaleField.setFloat(null, 1f)
        assertEquals(true, animatorsEnabled())
    }
    @Test fun dotKeepsItsRequestedSize() {
        compose.setContent { PiDashTheme { Surface { PulsingDot(Color.Red, 6.dp, Modifier.testTag("dot"), animate = false) } } }
        compose.onNodeWithTag("dot").assertWidthIsEqualTo(6.dp).assertHeightIsEqualTo(6.dp)
    }
    @Test fun dotCanNameTheStateForScreenReaders() {
        compose.setContent { PiDashTheme { PulsingDot(Color.Red, 6.dp, animate = false, contentDescription = "运行中") } }
        compose.onNodeWithContentDescription("运行中").assertExists()
    }
    @Test fun decorativeDotDoesNotAddAnAccessibilityNode() {
        compose.setContent { PiDashTheme { PulsingDot(Color.Red, 6.dp, Modifier.testTag("plain"), animate = false) } }
        compose.onNodeWithTag("plain").assertExists()
        compose.onNodeWithContentDescription("运行中").assertDoesNotExist()
    }
}