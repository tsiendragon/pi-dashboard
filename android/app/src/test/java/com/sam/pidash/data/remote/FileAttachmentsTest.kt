package com.sam.pidash.data.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileAttachmentsTest {
    @Test fun acceptsTheRequestedTextTypesAndPdf() {
        listOf("notes.md", "data.json", "app.py", "ci.yaml", "ci.yml", "a.txt", "nginx.conf", "rows.csv", "a.pdf")
            .forEach { assertTrue(it, FileAttachments.isSupported(it)) }
        listOf("run.exe", "lib.so", "photo.png", "archive.zip", "noextension")
            .forEach { assertFalse(it, FileAttachments.isSupported(it)) }
    }

    @Test fun extensionMatchingIsCaseInsensitive() {
        assertTrue(FileAttachments.isTextFile("README.MD"))
        assertTrue(FileAttachments.isPdf("Paper.PDF"))
        assertEquals("json", FileAttachments.extensionOf("a.b.JSON"))
    }

    @Test fun binaryContentIsRefusedRatherThanMangled() {
        assertNull(FileAttachments.decodeText(byteArrayOf(0x4d, 0x5a, 0x00, 0x01)))
        assertEquals("héllo\n", FileAttachments.decodeText("héllo\n".toByteArray()))
        assertEquals("", FileAttachments.decodeText(ByteArray(0)))
    }

    @Test fun validateEnforcesCountTotalAndEmptiness() {
        fun file(name: String, size: Int) =
            FileAttachments.TextAttachment(name, "x".repeat(size), size, truncated = false)
        assertNull(FileAttachments.validate(listOf(file("a.txt", 10))))
        assertTrue(FileAttachments.validate(List(FileAttachments.MAX_FILES + 1) { file("a.txt", 1) })!!.contains("最多"))
        assertTrue(FileAttachments.validate(listOf(file("a.txt", FileAttachments.MAX_TOTAL_BYTES + 1)))!!.contains("合计"))
        assertTrue(FileAttachments.validate(listOf(file("a.txt", 0)))!!.contains("空文件"))
    }

    @Test fun prefixNamesEachFileAndStatesTruncation() {
        val text = FileAttachments.prefix(
            listOf(
                FileAttachments.TextAttachment("rows.csv", "a,b\n1,2", 12, truncated = false),
                FileAttachments.TextAttachment("big.log", "line", 999_999, truncated = true),
            )
        )
        assertTrue(text.startsWith("文件：rows.csv（12 B）\n```csv\na,b\n1,2\n```"))
        assertTrue(text.contains("已截断"))
        assertTrue(text.contains("```log"))
    }

    @Test fun emptyPrefixKeepsTheMessageUntouched() {
        assertEquals("hi", com.sam.pidash.domain.model.composeOutgoing("hi", filePrefix = ""))
        assertEquals("文件：a.txt\n\nhi", com.sam.pidash.domain.model.composeOutgoing("hi", filePrefix = "文件：a.txt"))
    }
}
