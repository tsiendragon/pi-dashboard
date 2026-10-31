package com.sam.pidash

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repo = (application as PiDashApp).repository
        val displayPrefs = (application as PiDashApp).displayPrefs
        setContent {
            val fontScale by displayPrefs.fontScale.collectAsState()
            val density = LocalDensity.current
            // Keep dp sizing untouched and scale only sp text on top of the system font scale.
            val adjustedDensity = if (fontScale.multiplier == 1f) density else Density(
                density = density.density,
                fontScale = density.fontScale * fontScale.multiplier,
            )
            CompositionLocalProvider(LocalDensity provides adjustedDensity) {
                PiDashTheme {
                    AppNav(repo)
                }
            }
        }
    }
}
