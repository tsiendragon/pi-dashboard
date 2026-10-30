package com.sam.pidash.domain.model

import com.sam.pidash.ui.common.appVersionText
import com.sam.pidash.ui.common.backendOriginLabel
import com.sam.pidash.ui.common.liveConnectionLabel
import org.junit.Assert.*
import org.junit.Test

class MachineDashboardTest {
    private fun row(id: String, machine: String = "a", session: String = id, started: Long = 0, pinned: Boolean = false,
                    role: String = "main", parent: String? = null, status: String = "idle", tags: List<String> = emptyList()) =
        AggregatedLiveSession(SessionKey(machine, id), machine, LiveSummary(id, session, sessionName = id,
            cwd = "/allowed/Project", startedAt = started, role = role, parentSessionId = parent, status = status,
            model = LiveModel("provider", "model")), LiveMeta(pinned = pinned, tags = tags))
    private val groups = listOf(LiveGroup("work", "Work", listOf("one", "two")), LiveGroup("hold", "Hold", listOf("three")))
    private fun org(order: LiveOrder = LiveOrder()) = LiveOrganization(groups, order, loaded = true)

    @Test fun sameSessionIdsOnDifferentMachinesNeverMix() {
        val sections = machineSessionSections("a", listOf(row("one"), row("one", machine = "b")), org())
        assertEquals(listOf("a"), sections.flatMap { it.sessions }.map { it.key.backendId })
    }
    @Test fun pinnedIsFirstAndNotDuplicatedInItsGroup() {
        val sections = machineSessionSections("a", listOf(row("one", pinned = true), row("two"), row("other")), org())
        assertEquals(listOf("__pinned", "work", "__ungrouped"), sections.map { it.id })
        assertEquals(3, sections.flatMap { it.sessions }.map { it.key }.distinct().size)
    }
    @Test fun defaultOrderMatchesWebWithHoldLastAndCollapsed() {
        val sections = machineSessionSections("a", listOf(row("three"), row("other"), row("one")), org())
        assertEquals(listOf("work", "__ungrouped", "hold"), sections.map { it.id })
        assertTrue(sections.last().collapsedByDefault)
    }
    @Test fun explicitSectionOrderAndSessionOrderAreRespected() {
        val sections = machineSessionSections("a", listOf(row("one", started = 1), row("two", started = 2), row("three")),
            org(LiveOrder(listOf("two", "one"), listOf("hold", "work"))))
        assertEquals("hold", sections.first().id)
        assertEquals(listOf("two", "one"), sections.last().sessions.map { it.summary.sessionId })
    }
    @Test fun newRowsFollowManuallyRankedRowsWithStartedAtTieBreak() {
        val sections = machineSessionSections("a", listOf(row("z", started = 2), row("a", started = 1), row("ranked", started = 9)),
            LiveOrganization(order = LiveOrder(listOf("ranked"))))
        assertEquals(listOf("ranked", "a", "z"), sections.single().sessions.map { it.summary.sessionId })
    }
    @Test fun groupingUsesStableSessionIdNotRestartedProcessId() {
        val result = machineSessionSections("a", listOf(row("replacement-process", session = "one")), org())
        assertEquals("work", result.single().id)
    }
    @Test fun searchIsCaseInsensitiveAndCombinesPathModelGroupAndTags() {
        val rows = listOf(row("one", tags = listOf("urgent")), row("two", tags = listOf("later")))
        assertEquals("one", machineSessionSections("a", rows, org(), "WORK project PROVIDER #URGENT").single().sessions.single().summary.sessionId)
        assertTrue(machineSessionSections("a", rows, org(), "missing").isEmpty())
    }
    @Test fun matchingHoldSearchExpandsItAndRunningFilterIsExplicit() {
        val result = machineSessionSections("a", listOf(row("three", status = "running"), row("one")), org(), query = "hold", runningOnly = true)
        assertEquals("hold", result.single().id)
        assertFalse(result.single().collapsedByDefault)
    }
    @Test fun childAgentsDoNotPolluteTopLevelButCanBeShown() {
        val rows = listOf(row("one"), row("child", role = "subagent"), row("nested", parent = "one"))
        assertEquals(listOf("one"), machineSessionSections("a", rows, org()).flatMap { it.sessions }.map { it.summary.sessionId })
        assertEquals(2, machineSessionSections("a", rows, org(), includeSubagents = true).last().sessions.size)
    }
    @Test fun historicalMembersDoNotCreateFakeOnlineRowsOrEmptySections() {
        assertTrue(machineSessionSections("a", emptyList(), org()).isEmpty())
    }
    @Test fun ordinaryChatConnectivityIsNeverUsedAsLiveConnectivity() {
        assertTrue(liveConnectionLabel(null).contains("正在检查"))
        assertTrue(liveConnectionLabel(LiveBackendState(needsToken = true)).contains("未登录"))
        assertTrue(liveConnectionLabel(LiveBackendState(connected = true)).contains("已连接"))
        assertTrue(liveConnectionLabel(LiveBackendState()).contains("未连接"))
    }
    @Test fun versionLabelIncludesBothPackageVersionAndBuildCode() {
        assertEquals("https://example.test", backendOriginLabel("https://user:synthetic-secret@example.test/private?token=synthetic#fragment"))
        assertEquals("v2.2 · build 3", appVersionText("2.2", 3))
        assertTrue(appVersionText().contains("build"))
    }
}
