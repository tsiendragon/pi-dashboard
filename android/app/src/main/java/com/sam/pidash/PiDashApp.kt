package com.sam.pidash

import android.app.Application
import com.sam.pidash.data.local.BackendStore
import com.sam.pidash.data.repo.PiDashRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Holds app-scoped singletons (manual DI — no framework needed). */
class PiDashApp : Application() {

    lateinit var repository: PiDashRepository
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        repository = PiDashRepository(BackendStore(this), appScope)
    }
}
