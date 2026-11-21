package com.sam.pidash.domain.model

/**
 * Whether a backgrounded app should keep its Live socket open.
 *
 * The only reason to stay connected off-screen is to observe a transition that needs
 * attention: a running turn finishing, or a request waiting for the user. Idle sockets
 * are closed immediately instead of keeping every backend awake indefinitely.
 */
fun shouldKeepLiveWatch(
    summaries: Collection<LiveSummary>,
    pending: Collection<LiveUiRequest>,
): Boolean = summaries.any { it.status == "running" } || pending.isNotEmpty()
