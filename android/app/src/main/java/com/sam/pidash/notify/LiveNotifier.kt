package com.sam.pidash.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import androidx.core.content.ContextCompat
import com.sam.pidash.MainActivity
import com.sam.pidash.R

/**
 * Posts the two Live alerts on a dedicated low-noise channel.
 *
 * No foreground service: alerts are emitted while the app process is alive with a
 * Live connection, which covers the common "screen off, come back later" case. If
 * Android reclaims the process, nothing is posted — the app says so where the
 * toggle lives instead of pretending otherwise.
 */
class LiveNotifier(private val context: Context) {
    val prefs = NotificationPrefs(context)

    /** Set false whenever the UI is not resumed; alerts are background-only. */
    @Volatile
    var foreground: Boolean = true
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "会话提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "后台时提醒会话完成或等待回答"
                }
            )
        }
    }

    fun canNotify(): Boolean =
        prefs.enabled && (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            )

    fun post(alert: LiveAlert) {
        if (!canNotify()) return
        if (!prefs.allows(alert.kind)) return
        if (prefs.inQuietHours(java.time.LocalTime.now().let { it.hour * 60 + it.minute })) return
        // Tapping lands on the conversation that asked for attention, not the app's front page.
        val open = PendingIntent.getActivity(
            context,
            alert.sessionKey.hashCode(),
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(MainActivity.EXTRA_BACKEND_ID, alert.backendId)
                putExtra(MainActivity.EXTRA_SLOT_KEY, alert.sessionKey)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_live)
            .setContentTitle(notificationTitle(if (prefs.hideTitle) "PiDash 会话提醒" else alert.title))
            .setContentText(alert.text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setGroup(GROUP)
            // One notification per session: a later "needs input" replaces the earlier
            // "completed" instead of stacking two rows for the same conversation.
            .setSortKey(alert.sessionKey)
        approvalActions(alert).forEach { action ->
            builder.addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(context, R.drawable.ic_stat_live),
                    action.label,
                    answerIntent(alert, action.value),
                ).build(),
            )
        }
        // Approvals are actionable, so keep them off the lock screen: the public version
        // carries no session name, no request and no buttons.
        val notification = builder
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(
                Notification.Builder(context, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_live)
                    .setContentTitle("PiDash 会话提醒")
                    .setContentText("解锁后查看")
                    .build(),
            )
            .build()
        manager.notify(idFor(alert.sessionKey), notification)
    }

    /** A shade button only ever answers the request the alert was built from. */
    private fun answerIntent(alert: LiveAlert, value: String): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            (alert.sessionKey + alert.request?.id + value).hashCode(),
            Intent(context, LiveAnswerReceiver::class.java).apply {
                action = LiveAnswerReceiver.ACTION_ANSWER
                putExtra(LiveAnswerReceiver.EXTRA_BACKEND, alert.backendId)
                putExtra(LiveAnswerReceiver.EXTRA_SESSION, alert.sessionKey)
                putExtra(LiveAnswerReceiver.EXTRA_REQUEST, alert.request?.id)
                putExtra(LiveAnswerReceiver.EXTRA_ALLOW, value == "true")
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** Opening a conversation clears its pending alert — the user has seen it. */
    fun cancel(sessionKey: String) = manager.cancel(idFor(sessionKey))

    private companion object {
        fun idFor(sessionKey: String): Int =
            sessionKey.hashCode().let { if (it == Int.MIN_VALUE) 0 else it }

        const val CHANNEL = "live_alerts"
        const val GROUP = "live_alerts"
    }
}
