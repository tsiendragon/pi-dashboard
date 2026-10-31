package com.sam.pidash.domain.model

/**
 * App-wide text size preference.
 *
 * [multiplier] is applied on top of the system font scale, so [STANDARD] keeps the user's
 * OS accessibility setting untouched. The stored value is the stable [storageValue], never
 * the enum ordinal, so the preference survives future reordering.
 */
enum class AppFontScale(val storageValue: String, val label: String, val multiplier: Float) {
    SMALL("small", "小", 0.85f),
    STANDARD("standard", "标准", 1f),
    LARGE("large", "大", 1.15f);

    companion object {
        fun fromStorage(value: String?): AppFontScale =
            entries.firstOrNull { it.storageValue == value } ?: STANDARD
    }
}
