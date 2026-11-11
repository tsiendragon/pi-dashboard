package com.sam.pidash

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.data.local.LiveDetailCacheStats
import com.sam.pidash.domain.model.Backend
import com.sam.pidash.domain.model.ConnectionState
import com.sam.pidash.domain.model.LiveBackendState
import com.sam.pidash.notify.NotificationPrefs
import com.sam.pidash.ui.backends.cacheSummary
import com.sam.pidash.ui.backends.diagnosticsText
import com.sam.pidash.ui.backends.formatBytes
import com.sam.pidash.ui.backends.formatMinute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class SettingsDiagnosticsTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before fun reset() {
        context.getSharedPreferences("pidash.notifications", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun bytesAndTimesReadLikeSettingsCopy() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("512 B", formatBytes(512))
        assertEquals("2 KB", formatBytes(2048))
        assertTrue(formatBytes(3 * 1024 * 1024).startsWith("3.0 MB"))
        assertEquals("07:05", formatMinute(7 * 60 + 5))
        assertEquals("00:00", formatMinute(24 * 60))
        assertEquals("暂无缓存", cacheSummary(LiveDetailCacheStats()))
    }

    @Test fun diagnosticsNameOriginsButNeverCredentialsPathsOrSessionContent() {
        val token = "edge-secret-token"
        val backend = Backend("b1", "my laptop", "https://pi.example.com/private/path?token=$token", token)
        val text = diagnosticsText(
            backends = listOf(backend),
            connection = mapOf("b1" to ConnectionState.Connected),
            liveStates = mapOf("b1" to LiveBackendState(connected = true)),
            stats = LiveDetailCacheStats(bytes = 1024, entries = 1, lastSavedAt = 1_700_000_000_000),
            notifications = NotificationPrefs(context).apply {
                enabled = true; needsInput = true; completed = false
                quietEnabled = true; quietStartMinutes = 22 * 60; quietEndMinutes = 8 * 60
            },
        )
        assertTrue(text.contains("https://pi.example.com"))
        assertFalse(text.contains(token))
        assertFalse(text.contains("/private/path"))
        assertFalse(text.contains("my laptop"))
        assertTrue(text.contains("已完成") || text.contains("完成 关"))
        assertTrue(text.contains("22:00–08:00"))
        assertTrue(text.contains("1 KB"))
    }
}
