package com.sam.pidash

import android.app.Application
import com.sam.pidash.data.local.BackendStore
import com.sam.pidash.data.local.DisplayPrefs
import com.sam.pidash.data.local.EncryptedLiveCookieStore
import com.sam.pidash.data.local.EncryptedLiveDetailCache
import com.sam.pidash.data.local.LiveDetailCacheStats
import com.sam.pidash.data.local.LiveDetailCacheLimits
import com.sam.pidash.data.local.SettingsPrefs
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.notify.LiveAlertWatcher
import com.sam.pidash.notify.LiveNotifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow

/** Holds app-scoped singletons (manual DI — no framework needed). */
class PiDashApp : Application() {

    lateinit var repository: PiDashRepository
        private set

    lateinit var displayPrefs: DisplayPrefs
        private set

    lateinit var notifier: LiveNotifier
        private set

    lateinit var settingsPrefs: SettingsPrefs
        private set

    /** Exposed so Settings can show size/clear it without rebuilding the repository. */
    lateinit var liveDetailCache: EncryptedLiveDetailCache
        private set

    /** Set from a notification tap; [AppNav] consumes it once the nav host is ready. */
    val pendingSession = MutableStateFlow<SessionKey?>(null)
    private lateinit var alerts: LiveAlertWatcher

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        settingsPrefs = SettingsPrefs(this)
        liveDetailCache = EncryptedLiveDetailCache(this) {
            LiveDetailCacheLimits(
                ttlMillis = settingsPrefs.cacheRetention.value.millis,
                maxEntries = 32,
                maxTotalBytes = 8L * 1024 * 1024,
                maxEntryBytes = 1536 * 1024,
            )
        }
        repository = PiDashRepository(
            BackendStore(this), appScope, EncryptedLiveCookieStore(this), liveDetailCache,
            cacheEnabled = { settingsPrefs.cacheEnabled.value },
        )
        displayPrefs = DisplayPrefs(this)
        notifier = LiveNotifier(this)
        alerts = LiveAlertWatcher(repository.live, notifier, appScope).also { it.start() }
    }
}
