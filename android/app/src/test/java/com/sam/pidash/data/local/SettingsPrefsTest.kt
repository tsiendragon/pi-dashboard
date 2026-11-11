package com.sam.pidash.data.local

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
class SettingsPrefsTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before fun reset() {
        context.getSharedPreferences("pidash.settings", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun defaultsAreConservativeAndReadable() {
        val prefs = SettingsPrefs(context)
        assertEquals(CodeFontScale.STANDARD, prefs.codeScale.value)
        assertFalse(prefs.collapseKeyboard.value)
        assertEquals("", prefs.defaultDeliver.value)
        assertEquals("", prefs.defaultModel.value)
        assertEquals("", prefs.defaultThinking.value)
        assertTrue(prefs.cacheEnabled.value)
        assertEquals(CacheRetention.STANDARD, prefs.cacheRetention.value)
    }

    @Test fun everyChoiceSurvivesANewInstance() {
        SettingsPrefs(context).apply {
            setCodeScale(CodeFontScale.XLARGE)
            setCollapseKeyboard(true)
            setDefaultDeliver("followUp")
            setDefaultModel(" anthropic/claude-sonnet-4 ")
            setDefaultThinking("high")
            setCacheEnabled(false)
            setCacheRetention(CacheRetention.LONG)
        }
        val reopened = SettingsPrefs(context)
        assertEquals(CodeFontScale.XLARGE, reopened.codeScale.value)
        assertTrue(reopened.collapseKeyboard.value)
        assertEquals("followUp", reopened.defaultDeliver.value)
        assertEquals("anthropic/claude-sonnet-4", reopened.defaultModel.value)
        assertEquals("high", reopened.defaultThinking.value)
        assertFalse(reopened.cacheEnabled.value)
        assertEquals(CacheRetention.LONG, reopened.cacheRetention.value)
        assertEquals(30 * 24L * 60 * 60 * 1000, reopened.cacheRetention.value.millis)
    }

    @Test fun unknownDeliveryModesAreRejectedInsteadOfStored() {
        val prefs = SettingsPrefs(context)
        try {
            prefs.setDefaultDeliver("interrupt-everything")
            throw AssertionError("should reject")
        } catch (_: IllegalArgumentException) {
            assertEquals("", prefs.defaultDeliver.value)
        }
    }

    @Test fun unknownStoredValuesFallBackToDefaults() {
        context.getSharedPreferences("pidash.settings", Context.MODE_PRIVATE).edit()
            .putString("code_scale", "huge").putInt("cache_days", 99).commit()
        val prefs = SettingsPrefs(context)
        assertEquals(CodeFontScale.STANDARD, prefs.codeScale.value)
        assertEquals(CacheRetention.STANDARD, prefs.cacheRetention.value)
    }
}
