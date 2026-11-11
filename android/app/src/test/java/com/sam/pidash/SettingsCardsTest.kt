package com.sam.pidash

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.data.local.LiveCachedDetail
import com.sam.pidash.data.local.LiveDetailCache
import com.sam.pidash.data.local.LiveDetailCacheKey
import com.sam.pidash.data.local.LiveDetailCacheStats
import com.sam.pidash.data.local.SettingsPrefs
import com.sam.pidash.ui.backends.CacheCard
import com.sam.pidash.ui.backends.NotificationDetailsCard
import com.sam.pidash.ui.backends.SessionDefaultsCard
import com.sam.pidash.notify.NotificationPrefs
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private class FakeCache(var statsValue: LiveDetailCacheStats) : LiveDetailCache {
    var cleared = false
    override suspend fun load(key: LiveDetailCacheKey, now: Long): LiveCachedDetail? = null
    override suspend fun save(key: LiveDetailCacheKey, detail: com.sam.pidash.domain.model.LiveDetail, now: Long) = true
    override suspend fun remove(key: LiveDetailCacheKey) = Unit
    override suspend fun clearBackend(backendId: String) = Unit
    override suspend fun stats(): LiveDetailCacheStats = statsValue
    override suspend fun clearAll() { cleared = true; statsValue = LiveDetailCacheStats() }
}

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class SettingsCardsTest {
    @get:Rule val compose = createComposeRule()
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var prefs: SettingsPrefs

    @Before fun reset() {
        context.getSharedPreferences("pidash.settings", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("pidash.notifications", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        prefs = SettingsPrefs(context)
    }

    @Test fun deliveryDefaultIsOneTapAndPersists() {
        compose.setContent { PiDashTheme { SessionDefaultsCard(prefs) } }
        compose.onNodeWithText("立即引导").performClick()
        assertEquals("steer", prefs.defaultDeliver.value)
        compose.onNodeWithText("排队").performClick()
        assertEquals("followUp", prefs.defaultDeliver.value)
        compose.onNodeWithText("跟随服务器").performClick()
        assertEquals("", prefs.defaultDeliver.value)
    }

    @Test fun theCardShowsTheSavedModelAndThinking() {
        prefs.setDefaultModel("anthropic/claude-sonnet-4")
        prefs.setDefaultThinking("high")
        compose.setContent { PiDashTheme { SessionDefaultsCard(prefs) } }
        compose.onNodeWithText("anthropic/claude-sonnet-4", substring = true).assertIsDisplayed()
        compose.onNodeWithText("思考：high", substring = true).assertIsDisplayed()
        compose.onNodeWithText("修改").assertIsDisplayed()
    }

    @Test fun cacheCardShowsUsageAndClearsOnConfirmation() {
        val cache = FakeCache(LiveDetailCacheStats(bytes = 2048, entries = 2, lastSavedAt = 1_700_000_000_000))
        compose.setContent { PiDashTheme { CacheCard(prefs, cache) } }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("已用 2 KB · 2 条", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("清除缓存").performClick()
        compose.onNodeWithText("清除本机缓存？").assertIsDisplayed()
        compose.onNodeWithText("清除").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("暂无缓存").fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(cache.cleared)
    }

    @Test fun turningOffOfflineCacheExplainsThatExistingFilesStay() {
        compose.setContent { PiDashTheme { CacheCard(prefs, FakeCache(LiveDetailCacheStats())) } }
        compose.onAllNodes(isToggleable()).onFirst().performClick()
        assertFalse(prefs.cacheEnabled.value)
        compose.onNodeWithText("保留时长").assertDoesNotExist()
    }

    @Test fun theCardsRenderTogetherAtPhoneWidth() {
        prefs.setDefaultDeliver("followUp")
        prefs.setDefaultModel("anthropic/claude-sonnet-4")
        prefs.setDefaultThinking("high")
        val cache = FakeCache(LiveDetailCacheStats(bytes = 64 * 1024, entries = 3, lastSavedAt = 1_700_000_000_000))
        compose.setContent {
            PiDashTheme {
                Column(
                    Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp),
                    verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
                ) {
                    SessionDefaultsCard(prefs)
                    CacheCard(prefs, cache)
                    NotificationDetailsCard(NotificationPrefs(context))
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/settings-cards.png")
    }

    @Test fun notificationKindsCanBeTurnedOffOneByOne() {
        val notifications = NotificationPrefs(context)
        compose.setContent { PiDashTheme { NotificationDetailsCard(notifications) } }
        compose.onAllNodes(isToggleable())[0].performClick()
        assertFalse(notifications.completed)
        compose.onAllNodes(isToggleable())[1].performClick()
        assertFalse(notifications.needsInput)
        compose.onAllNodes(isToggleable())[2].performClick()
        assertTrue(notifications.hideTitle)
    }
}
