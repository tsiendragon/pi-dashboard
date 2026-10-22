package com.sam.pidash.notify

import com.sam.pidash.domain.model.LiveSummary

/**
 * Which Live transitions deserve a system notification.
 *
 * Deliberately narrow: only things the user must act on or wants to know about
 * while the app is in the background — a run finishing, and the agent waiting for
 * an answer. Notification text never contains message bodies, tool arguments or
 * paths: the lock screen is not a trusted surface.
 */
enum class LiveAlertKind { COMPLETED, NEEDS_INPUT }

data class LiveAlert(
    val kind: LiveAlertKind,
    val sessionKey: String,
    val title: String,
    val text: String,
)

/** Consecutive notifications for the same session and kind are throttled. */
const val LIVE_ALERT_MIN_INTERVAL_MS = 30_000L

fun findLiveAlert(
    processInstanceId: String,
    previous: LiveSummary?,
    current: LiveSummary,
    previousPendingUi: Int,
    currentPendingUi: Int,
    title: String,
): LiveAlert? {
    if (currentPendingUi > previousPendingUi) {
        return LiveAlert(
            kind = LiveAlertKind.NEEDS_INPUT,
            sessionKey = processInstanceId,
            title = "需要你回答：$title",
            text = "Agent 正在等待你的选择或确认",
        )
    }
    if (previous?.status == "running" && current.status == "idle") {
        return LiveAlert(
            kind = LiveAlertKind.COMPLETED,
            sessionKey = processInstanceId,
            title = "已完成：$title",
            text = "这一轮回复结束，可以回来看结果",
        )
    }
    return null
}

/** Keep a notification title short enough for the system shade. */
fun notificationTitle(title: String, limit: Int = 60): String =
    if (title.length <= limit) title else title.take(limit - 1) + "…"
