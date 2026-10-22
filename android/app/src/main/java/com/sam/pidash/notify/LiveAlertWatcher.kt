package com.sam.pidash.notify

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.data.repo.LivePiRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Watches Live state and turns the two interesting transitions into notifications.
 *
 * Runs only while the app process is alive and the UI is **not** in the foreground;
 * the previous summary/pending-UI counts are kept per session so a state repeated
 * across recompositions cannot fire twice.
 */
class LiveAlertWatcher(
    private val live: LivePiRepository,
    private val notifier: LiveNotifier,
    private val scope: CoroutineScope,
) {
    private val summaries = mutableMapOf<String, LiveSummary>()
    private val pending = mutableMapOf<String, Int>()
    private val lastPosted = mutableMapOf<String, Long>()

    fun start() {
        scope.launch {
            live.details.collectLatest { details ->
                if (notifier.foreground || !notifier.canNotify()) {
                    remember(details)
                    return@collectLatest
                }
                details.forEach { (key, detail) -> inspect(key, detail) }
            }
        }
    }

    private fun remember(details: Map<SessionKey, LiveDetail>) {
        details.forEach { (key, detail) ->
            summaries[key.slotKey] = detail.summary
            pending[key.slotKey] = detail.pendingUi.size
        }
    }

    private fun inspect(key: SessionKey, detail: LiveDetail) {
        val current = detail.summary
        val previous = summaries[key.slotKey]
        val previousPending = pending[key.slotKey] ?: 0
        summaries[key.slotKey] = current
        pending[key.slotKey] = detail.pendingUi.size
        val alert = findLiveAlert(
            processInstanceId = key.slotKey,
            previous = previous,
            current = current,
            previousPendingUi = previousPending,
            currentPendingUi = detail.pendingUi.size,
            title = current.title,
        ) ?: return
        val stamp = "${alert.sessionKey}:${alert.kind}"
        val now = System.currentTimeMillis()
        val last = lastPosted[stamp] ?: 0L
        if (now - last < LIVE_ALERT_MIN_INTERVAL_MS) return
        lastPosted[stamp] = now
        notifier.post(alert)
    }
}
