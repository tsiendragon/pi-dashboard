package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppFontScaleTest {

    @Test
    fun missingOrUnknownStorageValueFallsBackToStandard() {
        assertEquals(AppFontScale.STANDARD, AppFontScale.fromStorage(null))
        assertEquals(AppFontScale.STANDARD, AppFontScale.fromStorage(""))
        assertEquals(AppFontScale.STANDARD, AppFontScale.fromStorage("huge"))
    }

    @Test
    fun everyTierRoundTripsThroughItsStorageValue() {
        AppFontScale.entries.forEach { scale ->
            assertEquals(scale, AppFontScale.fromStorage(scale.storageValue))
        }
    }

    @Test
    fun standardLeavesSystemFontScaleUntouched() {
        assertEquals(1f, AppFontScale.STANDARD.multiplier, 0f)
        assertTrue(AppFontScale.SMALL.multiplier < 1f)
        assertTrue(AppFontScale.LARGE.multiplier > 1f)
    }

    @Test
    fun tiersAreOrderedSmallStandardLarge() {
        assertEquals(listOf(AppFontScale.SMALL, AppFontScale.STANDARD, AppFontScale.LARGE), AppFontScale.entries)
    }
}
