package com.sam.pidash.data.remote

/**
 * Only real web links may leave the app.
 *
 * The transcript renderer derives taps from the text it drew, so a URL cannot be
 * invented by the model; this guard additionally pins the scheme and rejects
 * `javascript:`/`intent:`/`file:` and control characters.
 */
internal fun externalUrlAllowed(url: String): Boolean =
    url.length in 8..4096 &&
        (url.startsWith("https://") || url.startsWith("http://")) &&
        url.substringAfter("://").length > 1 &&
        url.none { it.isWhitespace() || it.isISOControl() } &&
        !url.contains("//\n")
