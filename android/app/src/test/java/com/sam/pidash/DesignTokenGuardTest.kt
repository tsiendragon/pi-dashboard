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
 * 3. Dialogs use the one sheet radius and font sizes come from PiType, so a copy-pasted
 *    dialog cannot reintroduce 28 dp corners or a 20 sp title.
 *
 * These are the machine-checked part of docs/android-ui-contract.md; the rest of that
 * contract is prose plus screenshot review.
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
    fun `theme colours are only dimmed through the tint scale`() {
        val literal = Regex(
            """(?:MaterialTheme\.colorScheme|scheme)\.(?:outline|outlineVariant|surfaceVariant|primary|secondaryContainer|tertiaryContainer)\.copy\(alpha = (?!Tints\.)[\w.]+\)""",
        )
        val offenders = kotlinFiles().filter { literal.containsMatchIn(it.readText()) }
        assertTrue(
            "Use Tints.* instead of a literal alpha: ${offenders.map { it.name }}",
            offenders.isEmpty(),
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

    @Test
    fun `dialogs keep the shared sheet radius`() {
        val offenders = mutableListOf<String>()
        for (file in kotlinFiles()) {
            val text = file.readText()
            var index = text.indexOf("AlertDialog(")
            while (index >= 0) {
                // The shape parameter lives in the same call header; lamdas follow it.
                val header = text.substring(index, (index + 320).coerceAtMost(text.length))
                if (!header.contains("shape = Radii.sheet")) {
                    offenders += "${file.name}:${text.take(index).count { it == '\n' } + 1}"
                }
                index = text.indexOf("AlertDialog(", index + 1)
            }
        }
        assertEquals("Pass shape = Radii.sheet to every AlertDialog: $offenders", emptyList<String>(), offenders)
    }

    @Test
    fun `font sizes come from the type scale`() {
        val offenders = kotlinFiles()
            .filterNot { it.invariantSeparatorsPath.contains("/ui/theme/") }
            .flatMap { file ->
                file.readLines().withIndex()
                    .filter { (_, line) -> Regex("""\bfontSize\s*=""").containsMatchIn(line) }
                    .filterNot { (_, line) -> line.contains("PiType") || line.contains("style.fontSize") }
                    .map { (index, line) -> "${file.name}:${index + 1} ${line.trim()}" }
            }
        assertEquals("Use PiType.* (or scale a PiType style) instead of a literal fontSize: $offenders", emptyList<String>(), offenders)
    }

    private fun kotlinFiles(): List<File> =
        sources.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
}
