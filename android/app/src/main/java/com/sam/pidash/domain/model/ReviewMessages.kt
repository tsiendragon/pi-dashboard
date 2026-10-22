package com.sam.pidash.domain.model

/**
 * Quote and annotation messages, byte-for-byte the same shape the WebUI's
 * `utils/reviewComments.ts` writes, so the agent reads both clients identically:
 *
 * ```
 * 引用（来自你的回复）：
 * > quoted sentence
 * ```
 *
 * ```
 * Please review and address these comments about the quoted parts of our conversation:
 *
 * [1] 你的回复
 * Quoted: "quoted sentence"
 * Comment: my note
 * ```
 */

/** Longest quote kept in a message; longer selections are ellipsized like the WebUI. */
const val MAX_QUOTE_CHARS = 160

/** Intro line the WebUI uses when comments target the conversation itself. */
const val CHAT_REVIEW_INTRO =
    "Please review and address these comments about the quoted parts of our conversation:"

data class AppQuote(
    val id: String,
    /** Whitespace-collapsed, length-capped quote. */
    val text: String,
    val role: String? = null,
    val entryId: String? = null,
)

data class AppReviewItem(
    val id: String,
    val label: String? = null,
    val quote: String? = null,
    val content: String,
)

/** Collapse a selection onto one line and cap it, so chips and messages stay readable. */
fun normalizeQuote(raw: String?): String? {
    val flat = raw?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
    if (flat.isEmpty()) return null
    if (flat.length <= MAX_QUOTE_CHARS) return flat
    return flat.take(MAX_QUOTE_CHARS - 1) + "…"
}

/** "你的回复" / "我的消息" / "会话内容" — identical wording to the WebUI. */
fun selectionLabel(role: String?): String = when (role) {
    "assistant" -> "你的回复"
    "user" -> "我的消息"
    else -> "会话内容"
}

private fun quoteBlock(text: String, label: String?): String {
    val head = if (label != null) "引用（来自$label）：" else "引用："
    val body = text.split('\n').joinToString("\n") { "> $it" }
    return "$head\n$body"
}

fun quoteReplyMessage(quotes: List<AppQuote>): String =
    quotes.joinToString("\n\n") { quoteBlock(it.text, selectionLabel(it.role)) }

fun reviewMessage(items: List<AppReviewItem>, intro: String = CHAT_REVIEW_INTRO): String {
    val blocks = items.mapIndexed { index, item ->
        val head = if (item.label != null) "[${index + 1}] ${item.label}" else "[${index + 1}]"
        val quoted = item.quote?.let { "\nQuoted: \"$it\"" }.orEmpty()
        "$head$quoted\nComment: ${item.content}"
    }
    return "$intro\n\n${blocks.joinToString("\n\n")}"
}

/**
 * What actually goes over the wire. Order matches the WebUI composer:
 * attached-file blocks, then quotes, then annotations, then the typed text.
 */
fun composeOutgoing(
    text: String,
    quotes: List<AppQuote> = emptyList(),
    reviews: List<AppReviewItem> = emptyList(),
    filePrefix: String = "",
): String = listOf(
    filePrefix.trim().takeIf { it.isNotEmpty() },
    quotes.takeIf { it.isNotEmpty() }?.let(::quoteReplyMessage),
    reviews.takeIf { it.isNotEmpty() }?.let { reviewMessage(it) },
    text.trim().takeIf { it.isNotEmpty() },
).mapNotNull { it }.joinToString("\n\n")
