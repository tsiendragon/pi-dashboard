package com.sam.pidash.ui.live

/** A new session/view starts at the latest content until the reader scrolls away. */
internal class LiveScrollPolicy {
    var initialized = false
        private set
    var following = true
        private set

    fun shouldScroll(itemCount: Int, scrolling: Boolean): Boolean =
        itemCount > 0 && !scrolling && (!initialized || following)

    fun onUserScroll(nearLatest: Boolean) {
        initialized = true
        following = nearLatest
    }

    fun onAutoScroll() {
        initialized = true
        following = true
    }
}

/** The last item may be much taller than the viewport; its index alone is not enough. */
internal fun isNearLatest(
    itemCount: Int,
    lastVisibleIndex: Int?,
    lastVisibleEnd: Int,
    viewportEnd: Int,
    thresholdPx: Int,
): Boolean = itemCount > 0 && lastVisibleIndex == itemCount - 1 &&
    lastVisibleEnd.toLong() - viewportEnd.toLong() <= thresholdPx.coerceAtLeast(0).toLong()
