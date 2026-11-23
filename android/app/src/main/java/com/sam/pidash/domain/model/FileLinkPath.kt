package com.sam.pidash.domain.model

import java.io.File
import java.net.URI
import java.net.URLDecoder

/**
 * Resolve the local paths agents put in Markdown. They are often relative to the
 * session cwd, or wrapped in a file URI by the renderer; the older preview sent them
 * straight to `/api/file-read`, which only understood absolute paths.
 */
object FileLinkPath {
    private val lineSuffix = Regex(""":\d+(?::\d+)?$""")

    fun resolve(raw: String, cwd: String?): String? {
        var path = raw.trim().trim('`', '"', '\'')
        if (path.isEmpty()) return null
        if (path.startsWith("file://", ignoreCase = true)) {
            path = runCatching { URI(path).path }.getOrNull() ?: return null
        }
        path = path.removePrefix("sandbox:")
        path = runCatching { URLDecoder.decode(path, "UTF-8") }.getOrDefault(path)
        // A Markdown local link may carry a cache/query suffix; it is not part of the file name.
        path = path.substringBefore('?').substringBefore('#')
        path = path.replace(lineSuffix, "")
        if (path.isBlank() || path.contains('\u0000') || path.contains("://") || path.startsWith("//")) return null
        while (path.startsWith("./")) path = path.removePrefix("./")
        if (path.startsWith("/") || path.startsWith("~/")) return path
        val base = cwd?.trim()?.takeIf { it.startsWith("/") || it.startsWith("~/") } ?: return null
        return File(base, path).path
    }

    fun isPdf(path: String): Boolean =
        path.substringBefore('?').substringBefore('#').substringAfterLast('.', "").equals("pdf", ignoreCase = true)

    fun isMarkdown(path: String): Boolean {
        val extension = path.substringBefore('?').substringBefore('#').substringAfterLast('.', "").lowercase()
        return extension == "md" || extension == "markdown"
    }
}
