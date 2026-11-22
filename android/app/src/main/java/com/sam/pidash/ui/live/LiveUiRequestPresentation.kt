package com.sam.pidash.ui.live

import com.sam.pidash.domain.model.LiveUiRequest

/**
 * Return the oldest unanswered request when it is not already being shown.
 * Keep an open request stable; the next one is surfaced after it is answered or closed.
 */
internal fun nextRequestToAutoOpen(
    pending: List<LiveUiRequest>,
    answeredIds: Set<String>,
    openedRequestId: String?,
): LiveUiRequest? {
    val oldest = pending.firstOrNull { it.id !in answeredIds } ?: return null
    return oldest.takeIf { it.id != openedRequestId }
}
