package com.sam.pidash

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repo = (application as PiDashApp).repository
        setContent {
            PiDashTheme {
                AppNav(repo)
            }
        }
    }
}
