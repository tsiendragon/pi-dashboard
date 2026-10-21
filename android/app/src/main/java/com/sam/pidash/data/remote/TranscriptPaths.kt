package com.sam.pidash.data.remote

/**
 * A path may only be opened if the reader can already see it.
 *
 * The renderer page asks the native side to open whatever was tapped. Without
 * this check, anything that ends up in rendered text (a model answer, a tool
 * result, an injected attribute) could make the app fetch a file the user never
 * saw. Restricting the request to paths that literally appear in the current
 * transcript keeps the boundary at "what is on screen".
 */
internal fun pathVisibleInTranscript(transcript: String, path: String): Boolean {
    val candidate = path.trim()
    if (candidate.isEmpty() || candidate.length > 4096) return false
    if (candidate.any { it == '\u0000' || it == '\n' || it == '\r' || it == '\t' }) return false
    if (candidate.startsWith("http://") || candidate.startsWith("https://")) return false
    return transcript.contains(candidate) || candidate.removePrefix("./").let { transcript.contains(it) }
}

/** External links are opened by the system browser; only these schemes are allowed. */
internal fun externalUrlAllowed(url: String): Boolean =
    (url.startsWith("https://") || url.startsWith("http://")) &&
        url.length <= 4096 &&
        url.none { it == '\u0000' || it == '\n' || it == '\r' || it == '\t' || it == ' ' }
