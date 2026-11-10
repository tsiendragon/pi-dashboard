package com.sam.pidash

import com.sam.pidash.domain.model.terminalDisplay
import com.sam.pidash.ui.live.runnableLanguage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalTextTest {
    @Test fun colourAndCursorSequencesAreRemoved() {
        assertEquals("hello world", terminalDisplay("\u001B[32mhello\u001B[0m world"))
        assertEquals("12%\n", terminalDisplay("12%\u001B[K\n"))
        assertEquals("title", terminalDisplay("\u001B]0;title\u0007title"))
    }

    @Test fun carriageReturnsBecomeLineBreaksSoProgressDoesNotOverwrite() {
        assertEquals("a\nb\n", terminalDisplay("a\r\nb\r"))
    }

    @Test fun backspaceAndOtherControlBytesAreDroppedInsteadOfShown() {
        assertEquals("ab", terminalDisplay("a\u0008b"))
        assertEquals("bell", terminalDisplay("bell\u0007"))
        assertEquals("tab\there", terminalDisplay("tab\there"))
    }

    @Test fun aPasswordPromptKeepsItsTextSoTheUserCanSeeWhatIsAsked() {
        assertEquals("Password: ", terminalDisplay("Password: \u001B[?25h"))
    }

    @Test fun onlyShellBlocksAreRunnable() {
        for (language in listOf("bash", "sh", "shell", "zsh", "console", "BASH")) {
            assertTrue(language, runnableLanguage(language))
        }
        for (language in listOf(null, "", "text", "python", "json", "markdown")) {
            assertFalse("language=$language", runnableLanguage(language))
        }
    }
}