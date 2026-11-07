package com.sam.pidash

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import com.sam.pidash.domain.model.AppTheme
import androidx.core.view.WindowCompat
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.nav.AppNav
import com.sam.pidash.ui.theme.PiDashTheme

/** Single-activity Compose host. */
class MainActivity : ComponentActivity() {
    override fun onStart() {
        super.onStart()
        (application as PiDashApp).repository.live.setForeground(true)
    }

    override fun onStop() {
        (application as PiDashApp).repository.live.setForeground(false)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        (application as PiDashApp).notifier.foreground = true
    }

    override fun onPause() {
        (application as PiDashApp).notifier.foreground = false
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openFrom(intent)
    }

    private fun openFrom(intent: Intent?) {
        val backendId = intent?.getStringExtra(EXTRA_BACKEND_ID) ?: return
        val slotKey = intent.getStringExtra(EXTRA_SLOT_KEY) ?: return
        (application as PiDashApp).pendingSession.value = SessionKey(backendId, slotKey)
        // Consume the extras so a rotation or process restore does not re-navigate.
        intent.removeExtra(EXTRA_BACKEND_ID)
        intent.removeExtra(EXTRA_SLOT_KEY)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openFrom(intent)
        val repo = (application as PiDashApp).repository
        val displayPrefs = (application as PiDashApp).displayPrefs
        setContent {
            val fontScale by displayPrefs.fontScale.collectAsState()
            val theme by displayPrefs.theme.collectAsState()
            val dark = when (theme) {
                AppTheme.LIGHT -> false
                AppTheme.DARK -> true
                AppTheme.SYSTEM -> isSystemInDarkTheme()
            }
            // System bars follow the in-app choice, not just the OS setting.
            SideEffect {
                val bars = WindowCompat.getInsetsController(window, window.decorView)
                bars.isAppearanceLightStatusBars = !dark
                bars.isAppearanceLightNavigationBars = !dark
            }
            val density = LocalDensity.current
            // Keep dp sizing untouched and scale only sp text on top of the system font scale.
            val adjustedDensity = if (fontScale.multiplier == 1f) density else Density(
                density = density.density,
                fontScale = density.fontScale * fontScale.multiplier,
            )
            CompositionLocalProvider(LocalDensity provides adjustedDensity) {
                PiDashTheme(darkTheme = dark) {
                    AppNav(repo)
                }
            }
        }
    }

    companion object {
        const val EXTRA_BACKEND_ID = "com.sam.pidash.extra.BACKEND_ID"
        const val EXTRA_SLOT_KEY = "com.sam.pidash.extra.SLOT_KEY"
    }
}
