package com.sam.pidash.notify

import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.LiveUiRequest

/**
 * Which Live transitions deserve a system notification.
 *
 * Deliberately narrow: only things the user must act on or wants to know about
 * while the app is in the background — a run finishing, and the agent waiting for
 * an answer. Notification text never contains message bodies, tool arguments,
 * credential prompts or paths: the lock screen is not a trusted surface.
 */
enum class LiveAlertKind { COMPLETED, NEEDS_INPUT }

data class LiveAlert(
    val kind: LiveAlertKind,
    val backendId: String,
    val sessionKey: String,
    val title: String,
    val text: String,
    /** The request that needs an answer, so the shade can answer without opening the app. */
    val request: LiveUiRequest? = null,
)

/** One button on the notification. Only [LiveAlertAction.value] is ever sent back. */
data class LiveAlertAction(val label: String, val value: String)

/**
 * Which requests may be settled straight from the shade.
 *
 * Only `confirm` qualifies: its answer is a single boolean. Sudo always needs the password
 * typed into the app's secure dialog, and select/input/editor need free text, so those
 * notifications open the conversation instead of pretending to answer.
 */
fun approvalActions(alert: LiveAlert): List<LiveAlertAction> =
    if (alert.request?.method == "confirm") {
        listOf(LiveAlertAction("允许", "true"), LiveAlertAction("拒绝", "false"))
    } else {
        emptyList()
    }

fun findLiveAlert(
    backendId: String,
    processInstanceId: String,
    previous: LiveSummary?,
    current: LiveSummary,
    previousPending: List<LiveUiRequest>,
    pending: List<LiveUiRequest>,
    title: String,
): LiveAlert? {
    val fresh = pending.firstOrNull { request -> previousPending.none { it.id == request.id } }
    if (fresh != null) {
        return LiveAlert(
            kind = LiveAlertKind.NEEDS_INPUT,
            backendId = backendId,
            sessionKey = processInstanceId,
            title = "需要你回答：$title",
            text = if (fresh.method == "sudo") "有一条 sudo 授权请求等待处理" else "Agent 正在等待你的选择或确认",
            request = fresh,
        )
    }
    if (previous?.status == "running" && current.status == "idle") {
        return LiveAlert(
            kind = LiveAlertKind.COMPLETED,
            backendId = backendId,
            sessionKey = processInstanceId,
            title = "已完成：$title",
            text = "这一轮回复结束，可以回来看结果",
        )
    }
    return null
}

/** Consecutive notifications for the same session and kind are throttled. */
const val LIVE_ALERT_MIN_INTERVAL_MS = 30_000L

/** Keep a notification title short enough for the system shade. */
fun notificationTitle(title: String, limit: Int = 60): String =
    if (title.length <= limit) title else title.take(limit - 1) + "…"