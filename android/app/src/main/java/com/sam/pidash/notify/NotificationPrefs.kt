package com.sam.pidash.notify

import android.content.Context

/** One shared preference: notifications are opt-in and stay off until asked for. */
class NotificationPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("pidash.notifications", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    /** Finished runs and "needs you" can be silenced separately: many people only want the latter. */
    var completed: Boolean
        get() = prefs.getBoolean(KEY_COMPLETED, true)
        set(value) = prefs.edit().putBoolean(KEY_COMPLETED, value).apply()

    var needsInput: Boolean
        get() = prefs.getBoolean(KEY_NEEDS_INPUT, true)
        set(value) = prefs.edit().putBoolean(KEY_NEEDS_INPUT, value).apply()

    /** Hide the session title in the shade; the lock screen is already generic. */
    var hideTitle: Boolean
        get() = prefs.getBoolean(KEY_HIDE_TITLE, false)
        set(value) = prefs.edit().putBoolean(KEY_HIDE_TITLE, value).apply()

    var quietEnabled: Boolean
        get() = prefs.getBoolean(KEY_QUIET_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_QUIET_ENABLED, value).apply()

    var quietStartMinutes: Int
        get() = prefs.getInt(KEY_QUIET_START, 22 * 60).coerceIn(0, 24 * 60 - 1)
        set(value) = prefs.edit().putInt(KEY_QUIET_START, value.coerceIn(0, 24 * 60 - 1)).apply()

    var quietEndMinutes: Int
        get() = prefs.getInt(KEY_QUIET_END, 8 * 60).coerceIn(0, 24 * 60 - 1)
        set(value) = prefs.edit().putInt(KEY_QUIET_END, value.coerceIn(0, 24 * 60 - 1)).apply()

    fun allows(kind: LiveAlertKind): Boolean = when (kind) {
        LiveAlertKind.COMPLETED -> completed
        LiveAlertKind.NEEDS_INPUT -> needsInput
    }

    fun inQuietHours(minuteOfDay: Int): Boolean =
        quietEnabled && isQuietMinute(minuteOfDay, quietStartMinutes, quietEndMinutes)

    private companion object {
        const val KEY_ENABLED = "live_alerts"
        const val KEY_COMPLETED = "notify_completed"
        const val KEY_NEEDS_INPUT = "notify_needs_input"
        const val KEY_HIDE_TITLE = "hide_title"
        const val KEY_QUIET_ENABLED = "quiet_enabled"
        const val KEY_QUIET_START = "quiet_start"
        const val KEY_QUIET_END = "quiet_end"
    }
}

/**
 * True when [minuteOfDay] falls in a quiet window, including windows that cross midnight.
 * start == end means "no window", not "all day", so a zero-length choice is never surprising.
 */
fun isQuietMinute(minuteOfDay: Int, startMinutes: Int, endMinutes: Int): Boolean {
    if (startMinutes == endMinutes) return false
    val minute = ((minuteOfDay % 1440) + 1440) % 1440
    return if (startMinutes < endMinutes) minute >= startMinutes && minute < endMinutes
    else minute >= startMinutes || minute < endMinutes
}
