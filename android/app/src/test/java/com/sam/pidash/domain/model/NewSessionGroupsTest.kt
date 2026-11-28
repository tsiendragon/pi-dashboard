package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Group choices for the new-session sheet: only the machine's own groups, in its own order. */
class NewSessionGroupsTest {
    private fun group(id: String, name: String) = LiveGroup(id = id, name = name, sessionIds = listOf("s-$id"))

    @Test fun groupsAreOfferedInServerOrderWithoutInventingEntries() {
        val choices = newSessionGroupChoices(
            LiveOrganization(groups = listOf(group("work", "Work"), group("hold", "hold")), loaded = true),
        )
        assertEquals(listOf("work", "hold"), choices.map { it.id })
        assertEquals(listOf("Work", "hold"), choices.map { it.name })
    }

    @Test fun unloadedOrFailedOrganizationOffersNothingSoTheDefaultStaysUnchanged() {
        assertTrue(newSessionGroupChoices(LiveOrganization()).isEmpty())
        assertTrue(newSessionGroupChoices(LiveOrganization(error = "分组加载失败")).isEmpty())
    }

    @Test fun blankOrDuplicateIdsAreDroppedBecauseMembershipWouldBeRejected() {
        val choices = newSessionGroupChoices(
            LiveOrganization(groups = listOf(group("", "无标识"), group("work", "Work"), group("work", "Work again")), loaded = true),
        )
        assertEquals(listOf("work"), choices.map { it.id })
        assertEquals("Work", choices.single().name)
    }
}