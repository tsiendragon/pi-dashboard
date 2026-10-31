package com.sam.pidash.data.local

import android.content.Context
import com.sam.pidash.domain.model.AppFontScale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Private SharedPreferences-backed appearance settings.
 *
 * Kept synchronous (unlike the DataStore-backed backend list) because the first composition
 * needs the saved font scale immediately; otherwise the UI would visibly resize after launch.
 */
class DisplayPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("pidash.display", Context.MODE_PRIVATE)

    private val _fontScale = MutableStateFlow(
        AppFontScale.fromStorage(prefs.getString(KEY_FONT_SCALE, null)),
    )
    val fontScale: StateFlow<AppFontScale> = _fontScale.asStateFlow()

    fun setFontScale(scale: AppFontScale) {
        if (_fontScale.value == scale) return
        prefs.edit().putString(KEY_FONT_SCALE, scale.storageValue).apply()
        _fontScale.value = scale
    }

    private companion object {
        const val KEY_FONT_SCALE = "font_scale"
    }
}
