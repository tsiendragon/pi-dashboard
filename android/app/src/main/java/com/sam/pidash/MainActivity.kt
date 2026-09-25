package com.sam.pidash

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.sam.pidash.ui.nav.AppNav
import com.sam.pidash.ui.theme.PiDashTheme

/** Single-activity Compose host. */
class MainActivity : ComponentActivity() {
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
