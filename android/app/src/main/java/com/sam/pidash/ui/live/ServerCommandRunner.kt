package com.sam.pidash.ui.live

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Lets a shell code block offer "运行" without threading a callback through every
 * transcript card. Null outside a live session page — the action only exists where a
 * server session and its working directory are known.
 */
internal val LocalServerCommandRunner = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** Only commands, not arbitrary fenced output: a `text` block is not runnable. */
internal fun runnableLanguage(language: String?): Boolean =
    language?.trim()?.lowercase() in setOf("bash", "sh", "shell", "zsh", "console")
