package com.sam.pidash.ui.live

import org.junit.Assert.*
import org.junit.Test

class BottomRefreshGestureTest {
    @Test fun upwardOverscrollArmsAndReleasesOnce() {
        val state = BottomRefreshGesture(100f)
        assertEquals(-120f, state.pull(-120f))
        assertTrue(state.ready); assertEquals(1f, state.progress)
        assertTrue(state.release(true)); assertEquals(0f, state.distancePx)
        assertFalse(state.release(true))
    }
    @Test fun downwardMotionCannotArmRefresh() {
        val state = BottomRefreshGesture(100f)
        assertEquals(0f, state.pull(200f)); assertEquals(0f, state.retract(200f))
        assertFalse(state.release(true))
    }
    @Test fun shortPullDoesNotRefresh() {
        val state = BottomRefreshGesture(100f)
        state.pull(-99f); assertFalse(state.ready); assertFalse(state.release(true))
        assertEquals(0f, state.distancePx)
    }
    @Test fun retractingDisarmsAndReturnsOnlyConsumedMotion() {
        val state = BottomRefreshGesture(100f)
        state.pull(-120f)
        assertEquals(40f, state.retract(40f)); assertFalse(state.ready)
        assertEquals(80f, state.retract(200f)); assertEquals(0f, state.distancePx)
        assertFalse(state.release(true))
    }
    @Test fun losingTheEdgeOrBeingDisabledCannotRefresh() {
        val state = BottomRefreshGesture(100f)
        state.pull(-120f); assertFalse(state.release(false)); assertEquals(0f, state.distancePx)
    }
    @Test fun progressIsBoundedWithoutDiscardingRetractionTravel() {
        val state = BottomRefreshGesture(100f)
        state.pull(-10000f); assertEquals(10000f, state.distancePx); assertEquals(1f, state.progress)
        assertEquals(500f, state.retract(500f)); assertTrue(state.ready)
        assertEquals(9500f, state.retract(9500f)); assertEquals(0f, state.distancePx)
    }
    @Test fun resetDropsAnUnreleasedGesture() {
        val state = BottomRefreshGesture(100f)
        state.pull(-120f); state.reset(); assertFalse(state.release(true))
    }
    @Test fun nonFiniteMotionIsIgnored() {
        val state = BottomRefreshGesture(100f)
        assertEquals(0f, state.pull(Float.NaN)); assertEquals(0f, state.retract(Float.POSITIVE_INFINITY))
        assertEquals(0f, state.distancePx)
        state.pull(-Float.MAX_VALUE); state.pull(-Float.MAX_VALUE)
        assertTrue(state.distancePx.isFinite()); assertEquals(1f, state.progress)
    }
    @Test(expected = IllegalArgumentException::class) fun invalidThresholdIsRejected() { BottomRefreshGesture(0f) }
}
