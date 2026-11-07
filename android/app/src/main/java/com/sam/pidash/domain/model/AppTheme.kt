package com.sam.pidash.domain.model

/**
 * App-wide light/dark preference.
 *
 * [SYSTEM] is the default so a device-level dark schedule keeps working; the explicit
 * options exist because the WebUI has its own switch and people expect the app to match.
 * Stored by [storageValue], never by ordinal.
 */
enum class AppTheme(val storageValue: String, val label: String) {
    SYSTEM("system", "跟随系统"),
    LIGHT("light", "浅色"),
    DARK("dark", "深色");

    companion object {
        fun fromStorage(value: String?): AppTheme =
            entries.firstOrNull { it.storageValue == value } ?: SYSTEM
    }
}
