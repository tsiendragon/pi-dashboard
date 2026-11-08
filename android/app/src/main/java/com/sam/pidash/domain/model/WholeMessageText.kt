package com.sam.pidash.domain.model

/** Text export only: no images/base64, UI requests, session metadata, or synthetic completion text. */
internal fun wholeMessageText(item: LiveTimelineItem): String {
    val tool = item.toolName != null || item.role == "tool" || item.role == "toolResult"
    if (!tool && item.thinking.isNullOrEmpty() && item.images.isEmpty() && !item.isError) return item.text
    return buildList {
        if (tool) {
            add("【工具：${item.toolName?.takeIf { it.isNotBlank() } ?: "未知工具"}】")
            add("状态：${if (item.isError) "失败" else item.status}")
        } else if (item.isError) add("【状态：失败】")
        item.thinking?.takeIf { it.isNotEmpty() }?.let { add("【思考】\n$it") }
        item.toolArgs?.takeIf { tool && it.isNotEmpty() }?.let { add("【参数】\n$it") }
        if (item.text.isNotEmpty()) add("【${if (tool) "输出" else "正文"}】\n${item.text}")
        if (item.images.isNotEmpty()) add("[包含 ${item.images.size} 张图片，图片本体未复制]")
    }.joinToString("\n\n")
}

/** Keep transcript order and repeated entries; never export only the final reply or a UI preview. */
internal fun wholeActivityText(items: List<LiveTimelineItem>): String = items.mapNotNull { item ->
    val text = wholeMessageText(item)
    if (text.isEmpty()) null else when {
        item.toolName != null || item.role == "tool" || item.role == "toolResult" -> text
        item.role == "user" -> "【用户请求】\n$text"
        item.role == "assistant" -> "【助手消息】\n$text"
        else -> "【记录：${item.role}】\n$text"
    }
}.joinToString("\n\n")
