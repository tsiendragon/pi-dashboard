package com.sam.pidash

import com.sam.pidash.domain.model.LiveUiRequest
import com.sam.pidash.ui.live.nextRequestToAutoOpen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveUiRequestPresentationTest {
    private fun request(id: String) = LiveUiRequest(id = id, method = "select", title = "Review goal")

    @Test fun opensTheOldestUnansweredRequest() {
        val first = request("first")
        val second = request("second")

        assertEquals(first, nextRequestToAutoOpen(listOf(first, second), emptySet(), null))
    }

    @Test fun doesNotReplaceARequestAlreadyOpen() {
        val first = request("first")
        val second = request("second")

        assertNull(nextRequestToAutoOpen(listOf(first, second), emptySet(), "first"))
    }

    @Test fun advancesToTheNextRequestAfterTheOpenOneIsAnswered() {
        val second = request("second")

        assertEquals(second, nextRequestToAutoOpen(listOf(second), setOf("first"), "first"))
    }

    @Test fun doesNotOpenAlreadyAnsweredOrMissingRequests() {
        val first = request("first")

        assertNull(nextRequestToAutoOpen(listOf(first), setOf("first"), null))
        assertNull(nextRequestToAutoOpen(emptyList(), emptySet(), null))
    }
}
