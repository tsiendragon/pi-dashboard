package com.sam.pidash.domain.model

/**
 * `/api/session-tree` returns a flat list of session files linked through
 * `forkOf`. The graph page draws it with Cytoscape; on a phone the same
 * information reads better as an indented tree, which is all this projection
 * computes — plus the depth so the UI only has to indent.
 */
data class SessionTreeRow(
    val entry: LiveSessionTreeEntry,
    /** 0 for family roots, +1 per fork level. */
    val depth: Int,
    /** True when this row is a fork of its parent (as opposed to the parent itself). */
    val forked: Boolean,
    /** Number of direct forks hanging off this session. */
    val forks: Int,
)

fun sessionTreeRows(entries: List<LiveSessionTreeEntry>): List<SessionTreeRow> {
    val byKey = entries.associateBy { it.key }
    val children = entries.filter { it.forkOf != null && it.forkOf != it.key && byKey.containsKey(it.forkOf) }
        .groupBy { it.forkOf!! }
        .mapValues { (_, value) -> value.sortedBy { it.timestamp.orEmpty() } }
    val rows = mutableListOf<SessionTreeRow>()
    val visited = mutableSetOf<String>()

    fun walk(entry: LiveSessionTreeEntry, depth: Int, forked: Boolean) {
        if (!visited.add(entry.key)) return
        rows += SessionTreeRow(entry, depth, forked, children[entry.key]?.size ?: 0)
        children[entry.key].orEmpty().forEach { child -> walk(child, depth + 1, forked = true) }
    }

    // Roots: no parent in the family (a missing parent must not hide its children).
    entries.filter { it.forkOf == null || !byKey.containsKey(it.forkOf) || it.forkOf == it.key }
        .sortedWith(compareByDescending<LiveSessionTreeEntry> { it.isFocus }.thenBy { it.timestamp.orEmpty() })
        .forEach { walk(it, 0, forked = false) }
    // Anything left over is part of a cycle: show it flat rather than dropping it.
    entries.forEach { if (it.key !in visited) walk(it, 0, forked = it.forkOf != null) }
    return rows
}

/** One-line summary for the tree dialog; keeps the dot-prefixed fork wording short. */
fun sessionTreeLabel(entry: LiveSessionTreeEntry): String = buildString {
    if (entry.isFocus) append("当前会话 ")
    append(entry.cwd?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: entry.key)
    append(" · ${entry.entryCount} 条")
    if (entry.isLive) append(" · 运行中")
    if (entry.partial) append(" · 仅尾部")
}
