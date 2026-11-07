package com.sam.pidash.domain.model

import java.util.Locale

/** Suggestions only: the server remains the authority for existence and start permissions. */
data class LiveDirectoryOption(val name: String, val path: String, val project: Boolean)

fun liveDirectoryOptions(candidates: List<LiveRepoCandidate>, roots: List<String>): List<LiveDirectoryOption> {
    val options = linkedMapOf<String, LiveDirectoryOption>()
    fun add(path: String, name: String, project: Boolean) {
        if (!path.startsWith("/") || path.contains('\u0000')) return
        val normalized = path.trimEnd('/').ifEmpty { "/" }
        options.putIfAbsent(normalized, LiveDirectoryOption(
            name.ifBlank { normalized.substringAfterLast('/').ifEmpty { "文件系统根目录" } }, normalized, project,
        ))
    }
    candidates.forEach { add(it.path, it.name, true) }
    roots.forEach { add(it, "", false) }
    return options.values.toList()
}

/** Case-insensitive AND matching across name and full path. Name matches sort before parent-path matches. */
fun searchLiveDirectories(options: List<LiveDirectoryOption>, query: String): List<LiveDirectoryOption> {
    val words = query.trim().lowercase(Locale.ROOT).split(Regex("\\s+")).filter(String::isNotEmpty)
    if (words.isEmpty()) return options
    val phrase = words.joinToString(" ")
    return options.filter { option ->
        val name = option.name.lowercase(Locale.ROOT)
        val path = option.path.lowercase(Locale.ROOT)
        words.all { it in name || it in path }
    }.sortedBy { option ->
        val name = option.name.lowercase(Locale.ROOT)
        when {
            name == phrase -> 0
            name.startsWith(phrase) -> 1
            words.all { it in name } -> 2
            else -> 3
        }
    }
}
