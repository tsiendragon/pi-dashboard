package com.sam.pidash.data.local

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Reading size for code and tool output; independent from the app-wide font scale. */
enum class CodeFontScale(val storageValue: String, val label: String, val multiplier: Float) {
    SMALL("small", "小", 0.9f),
    STANDARD("standard", "标准", 1f),
    LARGE("large", "大", 1.15f),
    XLARGE("xlarge", "特大", 1.3f);

    companion object {
        fun fromStorage(value: String?): CodeFontScale =
            entries.firstOrNull { it.storageValue == value } ?: STANDARD
    }
}

/** How long an offline transcript may be shown before the server is asked again. */
enum class CacheRetention(val days: Int, val label: String) {
    SHORT(3, "3 天"),
    STANDARD(7, "7 天"),
    LONG(30, "30 天");

    val millis: Long get() = days * 24L * 60L * 60L * 1000L

    companion object {
        fun fromDays(days: Int): CacheRetention = entries.firstOrNull { it.days == days } ?: STANDARD
    }
}

/**
 * App-wide preferences that are not about a specific session.
 *
 * Kept synchronous SharedPreferences like [DisplayPrefs]: these values are read during the
 * first composition (code size, keyboard behaviour) and a delayed read would visibly change
 * the UI after launch. Nothing secret is stored here.
 */
class SettingsPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("pidash.settings", Context.MODE_PRIVATE)

    private val _codeScale = MutableStateFlow(CodeFontScale.fromStorage(prefs.getString(KEY_CODE_SCALE, null)))
    val codeScale: StateFlow<CodeFontScale> = _codeScale.asStateFlow()

    private val _collapseKeyboard = MutableStateFlow(prefs.getBoolean(KEY_COLLAPSE_KEYBOARD, false))
    val collapseKeyboard: StateFlow<Boolean> = _collapseKeyboard.asStateFlow()

    private val _defaultDeliver = MutableStateFlow(prefs.getString(KEY_DELIVER, null).orEmpty())
    val defaultDeliver: StateFlow<String> = _defaultDeliver.asStateFlow()

    private val _defaultModel = MutableStateFlow(prefs.getString(KEY_MODEL, null).orEmpty())
    val defaultModel: StateFlow<String> = _defaultModel.asStateFlow()

    private val _defaultThinking = MutableStateFlow(prefs.getString(KEY_THINKING, null).orEmpty())
    val defaultThinking: StateFlow<String> = _defaultThinking.asStateFlow()

    private val _cacheEnabled = MutableStateFlow(prefs.getBoolean(KEY_CACHE_ENABLED, true))
    val cacheEnabled: StateFlow<Boolean> = _cacheEnabled.asStateFlow()

    private val _cacheRetention = MutableStateFlow(
        CacheRetention.fromDays(prefs.getInt(KEY_CACHE_DAYS, CacheRetention.STANDARD.days)),
    )
    val cacheRetention: StateFlow<CacheRetention> = _cacheRetention.asStateFlow()

    fun setCodeScale(value: CodeFontScale) {
        if (_codeScale.value == value) return
        prefs.edit().putString(KEY_CODE_SCALE, value.storageValue).apply()
        _codeScale.value = value
    }

    fun setCollapseKeyboard(value: Boolean) {
        if (_collapseKeyboard.value == value) return
        prefs.edit().putBoolean(KEY_COLLAPSE_KEYBOARD, value).apply()
        _collapseKeyboard.value = value
    }

    fun setDefaultDeliver(value: String) {
        require(value in setOf("", "steer", "followUp")) { "unknown delivery mode" }
        if (_defaultDeliver.value == value) return
        prefs.edit().putString(KEY_DELIVER, value).apply()
        _defaultDeliver.value = value
    }

    fun setDefaultModel(value: String) {
        val cleaned = value.trim().take(200)
        if (_defaultModel.value == cleaned) return
        prefs.edit().putString(KEY_MODEL, cleaned).apply()
        _defaultModel.value = cleaned
    }

    fun setDefaultThinking(value: String) {
        val cleaned = value.trim().take(40)
        if (_defaultThinking.value == cleaned) return
        prefs.edit().putString(KEY_THINKING, cleaned).apply()
        _defaultThinking.value = cleaned
    }

    fun setCacheEnabled(value: Boolean) {
        if (_cacheEnabled.value == value) return
        prefs.edit().putBoolean(KEY_CACHE_ENABLED, value).apply()
        _cacheEnabled.value = value
    }

    fun setCacheRetention(value: CacheRetention) {
        if (_cacheRetention.value == value) return
        prefs.edit().putInt(KEY_CACHE_DAYS, value.days).apply()
        _cacheRetention.value = value
    }

    private companion object {
        const val KEY_CODE_SCALE = "code_scale"
        const val KEY_COLLAPSE_KEYBOARD = "collapse_keyboard"
        const val KEY_DELIVER = "default_deliver"
        const val KEY_MODEL = "default_model"
        const val KEY_THINKING = "default_thinking"
        const val KEY_CACHE_ENABLED = "cache_enabled"
        const val KEY_CACHE_DAYS = "cache_days"
    }
}