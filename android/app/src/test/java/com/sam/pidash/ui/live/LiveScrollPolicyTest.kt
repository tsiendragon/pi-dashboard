package com.sam.pidash.ui.live

import org.junit.Assert.*
import org.junit.Test

class LiveScrollPolicyTest {
    @Test fun firstContentAnchorsButEmptyAndActiveGestureDoNot() {
        val policy = LiveScrollPolicy()
        assertFalse(policy.shouldScroll(0, scrolling = false))
        assertFalse(policy.shouldScroll(10, scrolling = true))
        assertTrue(policy.shouldScroll(10, scrolling = false))
        policy.onAutoScroll()
        assertTrue(policy.initialized)
        assertTrue(policy.shouldScroll(11, scrolling = false))
    }

    @Test fun readingHistoryStopsFollowingUntilUserReturnsToLatest() {
        val policy = LiveScrollPolicy()
        policy.onAutoScroll()
        policy.onUserScroll(nearLatest = false)
        assertFalse(policy.shouldScroll(20, scrolling = false))
        policy.onUserScroll(nearLatest = true)
        assertTrue(policy.shouldScroll(20, scrolling = false))
        assertFalse(policy.shouldScroll(20, scrolling = true))
    }

    @Test fun manualScrollBeforeInitialAnchorIsRespected() {
        val policy = LiveScrollPolicy()
        policy.onUserScroll(nearLatest = false)
        assertFalse(policy.shouldScroll(100, scrolling = false))
    }

    @Test fun lastIndexIsNotEnoughWhenTheLastItemIsTall() {
        assertFalse(isNearLatest(10, 8, 600, 600, 96))
        assertFalse(isNearLatest(10, 9, 1200, 600, 96))
        assertTrue(isNearLatest(10, 9, 680, 600, 96))
        assertTrue(isNearLatest(10, 9, 580, 600, 96))
        assertFalse(isNearLatest(0, null, 0, 600, 96))
    }

    @Test fun aNewViewHasItsOwnInitialAnchor() {
        val old = LiveScrollPolicy().apply { onUserScroll(nearLatest = false) }
        val fresh = LiveScrollPolicy()
        assertFalse(old.shouldScroll(20, scrolling = false))
        assertTrue(fresh.shouldScroll(20, scrolling = false))
    }
}
