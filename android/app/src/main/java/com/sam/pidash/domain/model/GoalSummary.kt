package com.sam.pidash.domain.model

/**
 * The goal anchor as the WebUI presents it (`shared/src/goal-anchor.ts` +
 * `GoalAnchorDialog.tsx`): the same status labels, the same work-item glyphs and
 * the same two staleness reasons. The App only renders it; editing stays with the
 * agent's `/goal` command, so nothing here writes.
 */

/** Absence of goal updates for this many messages means the anchor may be stale. */
const val GOAL_STALE_MESSAGE_THRESHOLD = 300

enum class GoalStaleness { COMPLETE_WITH_OPEN_ITEMS, NO_RECENT_UPDATE }

data class GoalSummary(
    val status: String?,
    val done: Int,
    val total: Int,
    val needsUser: Int,
    val stale: GoalStaleness?,
) {
    val statusLabel: String
        get() = when (status) {
            "active" -> "进行中"
            "paused" -> "已暂停"
            "complete" -> "已完成"
            else -> "未标注"
        }

    val percent: Int get() = if (total <= 0) 0 else ((done * 100.0) / total).toInt().coerceIn(0, 100)

    val staleMessage: String
        get() = when (stale) {
            GoalStaleness.COMPLETE_WITH_OPEN_ITEMS -> "目标标记为已完成，但仍有未完成的工作项。"
            GoalStaleness.NO_RECENT_UPDATE -> "已超过 $GOAL_STALE_MESSAGE_THRESHOLD 条消息没有更新目标，可能落后于实际进度。"
            null -> ""
        }
}

fun goalSummary(goal: LiveGoalAnchor?): GoalSummary? {
    if (goal == null) return null
    val total = goal.workItems.size
    val done = goal.workItems.count { it.state == "done" }
    val needsUser = goal.blockers.count { it.disposition == "needs_user" }
    val stale = when {
        goal.status == "complete" && total > 0 && done < total -> GoalStaleness.COMPLETE_WITH_OPEN_ITEMS
        total > 0 && done < total && goal.messagesSinceUpdate >= GOAL_STALE_MESSAGE_THRESHOLD -> GoalStaleness.NO_RECENT_UPDATE
        else -> null
    }
    return GoalSummary(goal.status, done, total, needsUser, stale)
}

/** Same glyphs as the WebUI so a screenshot of either client reads alike. */
fun workItemGlyph(state: String?): String = when (state) {
    "done" -> "✓"
    "in_progress" -> "◐"
    "blocked" -> "!"
    "deferred" -> "⏸"
    else -> "○"
}

fun workItemLabel(state: String?): String = when (state) {
    "todo" -> "待做"
    "in_progress" -> "进行中"
    "done" -> "已完成"
    "blocked" -> "受阻"
    "deferred" -> "暂缓"
    else -> "未标注"
}

fun blockerOwnerLabel(owner: String?): String = when (owner) {
    "agent" -> "Agent"
    "user" -> "用户"
    "external" -> "外部"
    else -> owner ?: "未标注"
}

fun blockerKindLabel(kind: String?): String = when (kind) {
    "technical" -> "技术问题"
    "dependency" -> "依赖"
    "external_wait" -> "等待外部"
    "permission_or_credential" -> "权限或凭据"
    "user_decision" -> "待用户决定"
    "policy_or_safety" -> "策略/安全"
    "scope_unclear" -> "范围不清"
    else -> kind ?: "阻塞"
}
