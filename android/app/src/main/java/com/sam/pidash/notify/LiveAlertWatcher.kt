package com.sam.pidash.notify

import com.sam.pidash.data.repo.LivePiRepository
import com.sam.pidash.domain.model.AggregatedLiveSession
import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.domain.model.SessionKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Watches Live state and turns the two interesting transitions into notifications.
 *
 * Uses the session list rather than only the focused transcript, so a run started from
 * another client is still noticed. Pending UI comes from the focused detail snapshot;
 * the list is refreshed by the same connection while background notification watching
 * is active.
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
    private val pending = mutableMapOf<String, List<LiveUiRequest>>()
    private val lastPosted = mutableMapOf<String, Long>()

    fun start() {
        scope.launch {
            combine(live.sessions, live.details) { sessions, details -> sessions to details }
                .collectLatest { (sessions, details) ->
                    if (notifier.foreground || !notifier.canNotify()) {
                        remember(sessions, details)
                        return@collectLatest
                    }
                    sessions.forEach { session -> inspect(session, details) }
                }
        }
    }

    private fun remember(sessions: List<AggregatedLiveSession>, details: Map<SessionKey, LiveDetail>) {
        sessions.forEach { session ->
            val key = session.key
            summaries[storageKey(key)] = session.summary
            pending[storageKey(key)] = details[key]?.pendingUi.orEmpty()
        }
    }

    private fun inspect(session: AggregatedLiveSession, details: Map<SessionKey, LiveDetail>) {
        val key = session.key
        val storage = storageKey(key)
        val current = session.summary
        val previous = summaries[storage]
        val previousPending = pending[storage].orEmpty()
        val currentPending = details[key]?.pendingUi.orEmpty()
        summaries[storage] = current
        pending[storage] = currentPending
        val alert = findLiveAlert(
            backendId = key.backendId,
            processInstanceId = key.slotKey,
            previous = previous,
            current = current,
            previousPending = previousPending,
            pending = currentPending,
            title = current.title,
        ) ?: return
        val stamp = "${key.backendId}:${key.slotKey}:${alert.kind}:${alert.request?.id.orEmpty()}"
        val now = System.currentTimeMillis()
        val last = lastPosted[stamp] ?: 0L
        if (now - last < LIVE_ALERT_MIN_INTERVAL_MS) return
        lastPosted[stamp] = now
        notifier.post(alert)
    }

    /** Slot ids are only unique within a backend; do not let two machines overwrite each other. */
    private fun storageKey(key: SessionKey): String = "${key.backendId}\u0000${key.slotKey}"
}
