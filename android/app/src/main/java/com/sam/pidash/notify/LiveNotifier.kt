package com.sam.pidash.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_live)
            .setContentTitle(notificationTitle(alert.title))
            .setContentText(alert.text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        manager.notify("${alert.sessionKey}:${alert.kind}".hashCode().let { if (it == Int.MIN_VALUE) 0 else it }, notification)
    }

    private companion object {
        const val CHANNEL = "live_alerts"
    }
}
