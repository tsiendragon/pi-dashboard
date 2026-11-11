package com.sam.pidash.notify

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class NotificationQuietTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before fun reset() {
        context.getSharedPreferences("pidash.notifications", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun aWindowThatCrossesMidnightWrapsAround() {
        assertTrue(isQuietMinute(23 * 60, 22 * 60, 8 * 60))
        assertTrue(isQuietMinute(0, 22 * 60, 8 * 60))
        assertTrue(isQuietMinute(7 * 60 + 59, 22 * 60, 8 * 60))
        assertFalse(isQuietMinute(8 * 60, 22 * 60, 8 * 60))
        assertFalse(isQuietMinute(21 * 60 + 59, 22 * 60, 8 * 60))
    }

    @Test fun aSameDayWindowIsHalfOpen() {
        assertTrue(isQuietMinute(12 * 60, 11 * 60, 14 * 60))
        assertFalse(isQuietMinute(11 * 60 - 1, 11 * 60, 14 * 60))
        assertFalse(isQuietMinute(14 * 60, 11 * 60, 14 * 60))
    }

    @Test fun aZeroLengthWindowMeansNoQuietTime() {
        assertFalse(isQuietMinute(22 * 60, 22 * 60, 22 * 60))
        assertFalse(isQuietMinute(0, 0, 0))
    }

    @Test fun completionAndNeedsInputCanBeSilencedSeparately() {
        val prefs = NotificationPrefs(context)
        prefs.enabled = true
        assertTrue(prefs.allows(LiveAlertKind.COMPLETED))
        assertTrue(prefs.allows(LiveAlertKind.NEEDS_INPUT))
        prefs.completed = false
        assertFalse(prefs.allows(LiveAlertKind.COMPLETED))
        assertTrue(prefs.allows(LiveAlertKind.NEEDS_INPUT))
        prefs.needsInput = false
        assertFalse(prefs.allows(LiveAlertKind.NEEDS_INPUT))
    }

    @Test fun quietHoursOnlyApplyWhenEnabledAndRespectTheSavedWindow() {
        val prefs = NotificationPrefs(context)
        prefs.quietStartMinutes = 22 * 60
        prefs.quietEndMinutes = 8 * 60
        assertFalse(prefs.inQuietHours(23 * 60))
        prefs.quietEnabled = true
        assertTrue(prefs.inQuietHours(23 * 60))
        assertFalse(prefs.inQuietHours(12 * 60))
        prefs.quietStartMinutes = -5
        prefs.quietEndMinutes = 99 * 60
        assertEquals(0, prefs.quietStartMinutes)
        assertEquals(24 * 60 - 1, prefs.quietEndMinutes)
    }
}
