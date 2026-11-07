package com.sam.pidash.domain.model

import org.junit.Assert.*
import org.junit.Test
import java.util.Locale

class LiveDirectoryOptionsTest {
    private val candidates = listOf(
        LiveRepoCandidate("pi-dashboard", "/home/pi/apps/pi-dashboard"),
        LiveRepoCandidate("api-worker", "/srv/team/API-worker"),
        LiveRepoCandidate("pi", "/srv/pi"),
        LiveRepoCandidate("other", "/home/pi/apps/other"),
    )
    private fun options() = liveDirectoryOptions(candidates, listOf("/home/pi/apps", "/srv/"))

    @Test fun emptySearchShowsDefaultProjectsThenRoots() {
        val options = options()
        assertEquals(candidates.map { it.path } + listOf("/home/pi/apps", "/srv"), options.map { it.path })
        assertEquals(options, searchLiveDirectories(options, "  "))
        assertTrue(options.first().project)
        assertFalse(options.last().project)
    }
    @Test fun matchesNamesAndFullPathsIgnoringCase() {
        assertEquals(listOf("api-worker"), searchLiveDirectories(options(), "API-WORKER").map { it.name })
        assertEquals(listOf("api-worker"), searchLiveDirectories(options(), "/SRV/TEAM").map { it.name })
        assertEquals(listOf("pi", "pi-dashboard", "api-worker", "other", "apps"), searchLiveDirectories(options(), "pi").map { it.name })
    }
    @Test fun multipleKeywordsCanMatchNameAndParentPath() {
        assertEquals(listOf("api-worker"), searchLiveDirectories(options(), "  team   worker \n").map { it.name })
        assertTrue(searchLiveDirectories(options(), "team dashboard").isEmpty())
    }
    @Test fun duplicatePathsUseProjectNamesAndKeepFirstPosition() {
        val result = liveDirectoryOptions(listOf(
            LiveRepoCandidate("first", "/srv/project/"), LiveRepoCandidate("duplicate", "/srv/project"),
        ), listOf("/srv/project/", "/srv", "/srv/"))
        assertEquals(listOf("/srv/project", "/srv"), result.map { it.path })
        assertEquals("first", result.first().name)
        assertTrue(result.first().project)
    }
    @Test fun invalidRelativeOrNulPathsNeverBecomeSuggestions() {
        assertEquals(emptyList<LiveDirectoryOption>(), liveDirectoryOptions(
            listOf(LiveRepoCandidate("bad", "~/apps"), LiveRepoCandidate("bad", "/bad\u0000path")),
            listOf("", "relative", "/bad\u0000"),
        ))
    }
    @Test fun rootAndBlankNamesHaveReadableFallbacks() {
        val result = liveDirectoryOptions(listOf(LiveRepoCandidate(" ", "/srv/project/")), listOf("/"))
        assertEquals("project", result.first().name)
        assertEquals("文件系统根目录", result.last().name)
        assertEquals("/", result.last().path)
    }
    @Test fun emptyAndNoMatchResultsAreExplicitlyEmpty() {
        assertTrue(searchLiveDirectories(emptyList(), "pi").isEmpty())
        assertTrue(searchLiveDirectories(options(), "unlisted-project").isEmpty())
    }
    @Test fun rebuildingForAnotherServerDoesNotRetainOldPaths() {
        val first = options()
        val second = liveDirectoryOptions(listOf(LiveRepoCandidate("second", "/another/server")), emptyList())
        assertTrue(searchLiveDirectories(first, "dashboard").isNotEmpty())
        assertTrue(searchLiveDirectories(second, "dashboard").isEmpty())
        assertEquals(listOf("/another/server"), second.map { it.path })
    }
    @Test fun searchDoesNotDependOnDeviceLocale() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"))
            assertEquals(listOf("api-worker"), searchLiveDirectories(options(), "API-WORKER").map { it.name })
        } finally { Locale.setDefault(previous) }
    }
    @Test fun chineseKeywordsAndLongUnbrokenPathsRemainSearchable() {
        val path = "/srv/" + "a".repeat(220) + "/配置中心"
        val result = liveDirectoryOptions(listOf(LiveRepoCandidate("配置中心", path)), emptyList())
        assertEquals(path, searchLiveDirectories(result, "配置 aaaa").single().path)
    }
}
