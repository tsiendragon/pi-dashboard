package com.sam.pidash.domain.model

/** Organization is owned by one Dashboard. Never merge equal group/session ids across machines. */
data class MachineSessionSection(
    val id: String,
    val name: String,
    val sessions: List<AggregatedLiveSession>,
    val collapsedByDefault: Boolean = false,
)

fun machineSessionSections(
    backendId: String,
    sessions: List<AggregatedLiveSession>,
    organization: LiveOrganization = LiveOrganization(),
    query: String = "",
    runningOnly: Boolean = false,
    includeSubagents: Boolean = false,
): List<MachineSessionSection> {
    val ranks = organization.order.order.distinct().withIndex().associate { it.value to it.index }
    val sorted = sessions.filter { it.key.backendId == backendId }.sortedWith(
        compareBy<AggregatedLiveSession> { ranks[it.summary.sessionId] ?: Int.MAX_VALUE }
            .thenBy { it.summary.startedAt }.thenBy { it.summary.processInstanceId })
    fun groupOf(row: AggregatedLiveSession) = organization.groups.firstOrNull { row.summary.sessionId in it.sessionIds }
    val terms = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.map { it.removePrefix("#") }
    val visible = sorted.filter { row ->
        val s = row.summary
        val haystack = listOf(s.title, s.cwd, s.sessionId, s.model?.let { "${it.provider}/${it.id}" }.orEmpty(),
            row.meta.tags.joinToString(" "), groupOf(row)?.name.orEmpty()).joinToString(" ")
        (!runningOnly || s.status == "running") && terms.all { haystack.contains(it, ignoreCase = true) }
    }
    val (children, main) = visible.partition { it.summary.role == "subagent" || it.summary.parentSessionId != null }
    val sections = mutableListOf<MachineSessionSection>()
    main.filter { it.meta.pinned }.takeIf { it.isNotEmpty() }?.let { sections += MachineSessionSection("__pinned", "置顶", it) }
    val rest = main.filterNot { it.meta.pinned }
    val holdIds = organization.groups.filter { it.name.trim().equals("hold", true) }.map { it.id }.toSet()
    val defaults = organization.groups.filterNot { it.id in holdIds }.map { it.id } + "__ungrouped" + holdIds
    val order = organization.order.sectionOrder.filter { it in defaults }.distinct().toMutableList()
    defaults.forEach { id ->
        if (id !in order) {
            var index = order.size
            if (id !in holdIds) while (index > 0 && order[index - 1] in holdIds) index--
            order.add(index, id)
        }
    }
    order.forEach { id ->
        val group = organization.groups.firstOrNull { it.id == id }
        val rows = rest.filter { if (group == null) groupOf(it) == null else groupOf(it)?.id == group.id }
        if (rows.isNotEmpty()) sections += MachineSessionSection(id, group?.name ?: "未分组", rows, id in holdIds && terms.isEmpty())
    }
    if (includeSubagents && children.isNotEmpty()) sections += MachineSessionSection("__subagents", "子 Agent", children)
    return sections
}
