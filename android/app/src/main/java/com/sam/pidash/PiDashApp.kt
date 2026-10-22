package com.sam.pidash

import android.app.Application
import com.sam.pidash.data.local.BackendStore
import com.sam.pidash.data.local.EncryptedLiveCookieStore
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.notify.LiveAlertWatcher
import com.sam.pidash.notify.LiveNotifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Holds app-scoped singletons (manual DI — no framework needed). */
class PiDashApp : Application() {

    lateinit var repository: PiDashRepository
        private set

    lateinit var notifier: LiveNotifier
        private set
    private lateinit var alerts: LiveAlertWatcher

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        repository = PiDashRepository(BackendStore(this), appScope, EncryptedLiveCookieStore(this))
        notifier = LiveNotifier(this)
        alerts = LiveAlertWatcher(repository.live, notifier, appScope).also { it.start() }
    }
}
