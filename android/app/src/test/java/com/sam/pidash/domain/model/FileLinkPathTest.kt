package com.sam.pidash.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FileLinkPathTest {
    @Test fun resolvesRelativeMarkdownLinksAgainstSessionCwd() {
        assertEquals("/work/docs/report.pdf", FileLinkPath.resolve("docs/report.pdf", "/work"))
        assertEquals("/work/report.md", FileLinkPath.resolve("./report.md:12", "/work"))
    }

    @Test fun decodesFileUrisAndEscapedSpaces() {
        assertEquals("/tmp/my report.pdf", FileLinkPath.resolve("file:///tmp/my%20report.pdf", "/work"))
        assertEquals("/tmp/100%.pdf", FileLinkPath.resolve("/tmp/100%25.pdf", "/work"))
    }

    @Test fun keepsAbsoluteAndHomePaths() {
        assertEquals("/tmp/report.pdf", FileLinkPath.resolve("`/tmp/report.pdf`", null))
        assertEquals("~/docs/report.md", FileLinkPath.resolve("~/docs/report.md", "/work"))
        assertEquals("/work/report.pdf", FileLinkPath.resolve("report.pdf?download=1", "/work"))
    }

    @Test fun refusesUnresolvableOrUnsafePaths() {
        assertNull(FileLinkPath.resolve("report.pdf", null))
        assertNull(FileLinkPath.resolve("", "/work"))
        assertNull(FileLinkPath.resolve("bad\u0000path", "/work"))
        assertNull(FileLinkPath.resolve("https://example.test/report.pdf", "/work"))
    }

    @Test fun detectsDocumentTypesWithoutBeingFooledByQueryStrings() {
        assertEquals(true, FileLinkPath.isPdf("/work/report.PDF?download=1"))
        assertEquals(true, FileLinkPath.isMarkdown("/work/notes.md#top"))
        assertEquals(false, FileLinkPath.isPdf("/work/notes.md"))
        assertEquals(false, FileLinkPath.isMarkdown("/work/report.pdf"))
    }
}
