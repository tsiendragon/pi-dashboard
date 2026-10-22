package com.sam.pidash.notify

import android.content.Context

/** One shared preference: notifications are opt-in and stay off until asked for. */
class NotificationPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("pidash.notifications", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    private companion object {
        const val KEY_ENABLED = "live_alerts"
    }
}
