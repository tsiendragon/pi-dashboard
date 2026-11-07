package com.sam.pidash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Guards the two conventions this app paid for in earlier rounds, because they are the kind
 * of thing a single copy-paste can undo for good:
 *
 * 1. Text styles come from `PiType`, not `MaterialTheme.typography` (the Material roles map
 *    to the same sizes today, but drift the moment a token changes).
 * 2. Chevrons and check marks are vector icons, not borrowed text glyphs, which are the only
 *    way to keep their optical size stable across fonts and font scales.
 *
 * Screenshot tests would cover more, but they need a rendering harness this project does not
 * have offline; these checks cost nothing and fail in the same review loop.
 */
class DesignTokenGuardTest {

    private val sources: File = File("src/main/java")

    @Test
    fun `app code does not reach for MaterialTheme typography`() {
        val offenders = kotlinFiles().filter { it.readText().contains("MaterialTheme.typography.") }
        assertEquals(
            "Use PiType.* instead of MaterialTheme.typography.*: ${offenders.map { it.name }}",
            emptyList<File>(),
            offenders,
        )
    }

    @Test
    fun `colour literals stay inside the theme package`() {
        val offenders = kotlinFiles()
            .filterNot { it.invariantSeparatorsPath.contains("/ui/theme/") }
            .filter { Regex("""Color\(0x[0-9A-Fa-f]{8}\)""").containsMatchIn(it.readText()) }
        assertEquals(
            "Move colour literals into ui/theme (palette or CodeColors): ${offenders.map { it.name }}",
            emptyList<File>(),
            offenders,
        )
    }

    @Test
    fun `glyphs are not used as icons`() {
        val banned = listOf('⌃', '⌄', '▾', '▴', '›')
        val offenders = kotlinFiles().filter { file ->
            val text = file.readText()
            banned.any { text.contains(it) }
        }
        assertTrue(
            "Replace text chevrons with Icons.Filled.*: ${offenders.map { it.name }}",
            offenders.isEmpty(),
        )
    }

    private fun kotlinFiles(): List<File> =
        sources.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
}
