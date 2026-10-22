package com.sam.pidash.domain.model

/**
 * What the agent is doing *right now*, derived from the turn's own records.
 *
 * The card is the only place a phone user looks, so the label must distinguish
 * "thinking" from "reading" from "writing" — not just say "working".
 */
enum class ActivityPhase { THINKING, READING, WRITING, COMMAND, SEARCH, CODE, TOOL, REPLYING, DONE, FAILED, WAITING }

data class ActivityStatus(val phase: ActivityPhase, val label: String, val tool: String? = null) {
    val running: Boolean get() = phase in setOf(
        ActivityPhase.THINKING, ActivityPhase.READING, ActivityPhase.WRITING,
        ActivityPhase.COMMAND, ActivityPhase.SEARCH, ActivityPhase.CODE, ActivityPhase.TOOL, ActivityPhase.REPLYING,
    )
    val failed: Boolean get() = phase == ActivityPhase.FAILED
}

/** Tool name → the verb a reader understands at a glance. */
internal fun phaseForTool(tool: String?): ActivityStatus = when {
    tool == null -> ActivityStatus(ActivityPhase.TOOL, "调用工具")
    tool.contains("bash") || tool.contains("shell") || tool == "run_shell" ->
        ActivityStatus(ActivityPhase.COMMAND, "执行命令", tool)
    tool.startsWith("read") || tool.contains("file_read") || tool == "view" ->
        ActivityStatus(ActivityPhase.READING, "读取文件", tool)
    tool.startsWith("write") || tool.contains("edit") || tool.contains("patch") || tool.contains("apply") ->
        ActivityStatus(ActivityPhase.WRITING, "写入文件", tool)
    tool.contains("grep") || tool.contains("search") || tool.contains("glob") || tool.contains("find") ->
        ActivityStatus(ActivityPhase.SEARCH, "搜索", tool)
    tool.contains("run_code") || tool.contains("code") -> ActivityStatus(ActivityPhase.CODE, "运行代码", tool)
    tool.contains("web") || tool.contains("fetch") || tool.contains("browser") ->
        ActivityStatus(ActivityPhase.SEARCH, "查阅资料", tool)
    else -> ActivityStatus(ActivityPhase.TOOL, "调用 $tool", tool)
}

fun activityStatus(activity: LiveActivity): ActivityStatus {
    val items = activity.items
    if (items.any { it.isError }) return ActivityStatus(ActivityPhase.FAILED, "失败")
    // A running tool wins: it is the only thing the user can wait on.
    items.lastOrNull { (it.role == "tool" || it.toolCallId != null) && it.status == "running" }?.let {
        return phaseForTool(it.toolName)
    }
    val working = activity.state == "工作中"
    if (working) {
        val hasText = items.any { it.role == "assistant" && it.text.isNotBlank() && !it.isError }
        return if (hasText) ActivityStatus(ActivityPhase.REPLYING, "回复中")
        else ActivityStatus(ActivityPhase.THINKING, "思考中")
    }
    if (activity.state == "重连中") return ActivityStatus(ActivityPhase.THINKING, "重连中")
    if (activity.state == "待确认" || activity.state == "执行状态待确认") {
        return ActivityStatus(ActivityPhase.WAITING, activity.state)
    }
    return ActivityStatus(ActivityPhase.DONE, "已回复")
}

/**
 * Three-line card preview: markdown markers stripped, code fences dropped,
 * whitespace collapsed — a card is a summary, not a document.
 */
fun activityPreview(text: String, maxLines: Int = 3): String {
    val cleaned = StringBuilder()
    var inFence = false
    var fenceLines = 0
    text.lineSequence().forEach { raw ->
        val line = raw.trim()
        if (line.startsWith("```")) {
            inFence = !inFence
            if (inFence) fenceLines = 0
            return@forEach
        }
        if (inFence) {
            // Keep at most two code lines so a code-heavy reply still reads as prose.
            if (fenceLines < 2) {
                if (cleaned.isNotEmpty()) cleaned.append(' ')
                cleaned.append("`").append(line).append("`")
                fenceLines++
            }
            return@forEach
        }
        if (line.isEmpty()) return@forEach
        val bare = line
            .replace(Regex("^#+\\s*"), "")
            .replace(Regex("^(>\\s*)+"), "")
            .trim()
            .replaceFirst(Regex("^([-*+]|\\d+[.)])\\s+"), "")
        if (bare.isEmpty()) return@forEach
        if (cleaned.isNotEmpty()) cleaned.append(' ')
        cleaned.append(bare)
    }
    val flat = cleaned.toString()
        .replace(Regex("\\*\\*|__|\\*|~~"), "")
        .replace(Regex("`([^`]*)`")) { it.groupValues[1] }
        .replace(Regex("\\[([^\\]]*)]\\([^)]*\\)")) { it.groupValues[1] }
        .replace(Regex("\\s+"), " ")
        .trim()
    if (flat.isEmpty()) return ""
    // Soft cap: a preview longer than ~3 lines is cut at a sentence boundary when possible.
    val cap = maxLines * 34
    if (flat.length <= cap) return flat
    val cut = flat.take(cap)
    val stop = cut.lastIndexOfAny(charArrayOf('。', '！', '？', '；', '.', '!', '?', ';'))
    return if (stop > cap / 2) cut.take(stop + 1) else cut.trimEnd() + "…"
}
