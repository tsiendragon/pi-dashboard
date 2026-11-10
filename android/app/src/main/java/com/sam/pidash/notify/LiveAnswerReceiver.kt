package com.sam.pidash.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sam.pidash.PiDashApp
import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Answers a yes/no extension request straight from the notification shade.
 *
 * Deliberately limited to `confirm`: the notification only carries the request id and the
 * boolean, never a password or free text. The answer goes through the same repository
 * call the in-app card uses, so server-side "first answer wins" still applies, and a
 * failed delivery leaves the notification in place instead of retrying blindly.
 */
class LiveAnswerReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val backendId = intent.getStringExtra(EXTRA_BACKEND) ?: return
        val sessionKey = intent.getStringExtra(EXTRA_SESSION) ?: return
        val requestId = intent.getStringExtra(EXTRA_REQUEST) ?: return
        val value = if (intent.getBooleanExtra(EXTRA_ALLOW, false)) "true" else "false"
        val app = context.applicationContext as? PiDashApp ?: return
        val pending = goAsync()
        // A cold start has not built its backend clients yet; wait briefly instead of
        // failing the tap, but never hold the receiver open indefinitely.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                withTimeoutOrNull(8_000) {
                    val ready = app.repository.live.awaitBackend(backendId)
                    if (!ready) return@withTimeoutOrNull
                    val request = LiveUiRequest(id = requestId, method = "confirm")
                    val answered = app.repository.live.answer(
                        SessionKey(backendId, sessionKey), request, value = value,
                    )
                    if (answered.isSuccess) app.notifier.cancel(sessionKey)
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val EXTRA_BACKEND = "backend"
        const val EXTRA_SESSION = "session"
        const val EXTRA_REQUEST = "request"
        const val EXTRA_ALLOW = "allow"
        const val ACTION_ANSWER = "com.sam.pidash.action.LIVE_ANSWER"
    }
}