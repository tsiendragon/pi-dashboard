package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Limits must match shared/src/live-sessions.ts so the bridge never refuses a UI-allowed send. */
class ImageAttachmentsTest {
    private fun image(bytes: Int, mime: String = "image/png") =
        LiveImage(mime, "A".repeat((bytes / 3) * 4)) // base64 length -> bytes on validate()

    @Test fun limitsMatchTheSharedProtocol() {
        assertEquals(3 * 1024 * 1024, ImageAttachments.MAX_IMAGE_BYTES)
        assertEquals(4, ImageAttachments.MAX_IMAGES)
        assertEquals(6 * 1024 * 1024, ImageAttachments.MAX_TOTAL_BYTES)
    }

    @Test fun fourSmallImagesAreAcceptable() {
        assertNull(ImageAttachments.validate(listOf(image(1000), image(2000), image(3000), image(4000))))
    }

    @Test fun tooManyImagesAreRejected() {
        assertNotNull(ImageAttachments.validate(List(5) { image(1000) }))
    }

    @Test fun oversizedSingleImageIsRejected() {
        assertNotNull(ImageAttachments.validate(listOf(image(3 * 1024 * 1024 + 1024))))
    }

    @Test fun totalOverSixMegabytesIsRejectedEvenWhenEachFits() {
        assertNotNull(ImageAttachments.validate(listOf(image(2_000_000), image(2_000_000), image(2_000_000), image(2_000_000))))
    }

    @Test fun unsupportedMimeAndEmptyDataAreRejected() {
        assertNotNull(ImageAttachments.validate(listOf(LiveImage("image/svg+xml", "AAAA"))))
        assertNotNull(ImageAttachments.validate(listOf(LiveImage("application/pdf", "AAAA"))))
        assertNotNull(ImageAttachments.validate(listOf(LiveImage("image/png", ""))))
        assertNull(ImageAttachments.validate(listOf(LiveImage("image/webp", "AAAA"))))
        assertNull(ImageAttachments.validate(listOf(LiveImage("image/gif", "AAAA"))))
    }

    @Test fun emptyAttachmentListIsValid() {
        assertNull(ImageAttachments.validate(emptyList()))
    }

    @Test fun providerMimeVariantsAreNormalised() {
        assertEquals("image/jpeg", ImageAttachments.normalizeMime("image/jpg"))
        assertEquals("image/jpeg", ImageAttachments.normalizeMime("IMAGE/JPEG; charset=binary"))
        assertEquals("image/png", ImageAttachments.normalizeMime("image/x-png"))
        assertEquals("image/png", ImageAttachments.normalizeMime("application/octet-stream", "screenshot.PNG"))
        assertEquals("image/webp", ImageAttachments.normalizeMime(null, "a.webp"))
        assertEquals(null, ImageAttachments.normalizeMime("application/pdf", "a.pdf"))
        assertEquals(null, ImageAttachments.normalizeMime(null, null))
    }

    @Test fun fileSignaturesDecideWhenTheProviderLies() {
        fun bytes(vararg values: Int) = values.map { it.toByte() }.toByteArray()
        assertEquals("image/png", ImageAttachments.sniffMime(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D)))
        assertEquals("image/jpeg", ImageAttachments.sniffMime(bytes(0xFF, 0xD8, 0xFF, 0xE0)))
        assertEquals("image/gif", ImageAttachments.sniffMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39)))
        val webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)
        assertEquals("image/webp", ImageAttachments.sniffMime(webp))
        assertEquals(null, ImageAttachments.sniffMime(bytes(0x25, 0x50, 0x44, 0x46)))
        assertEquals(null, ImageAttachments.sniffMime(ByteArray(0)))
    }
}
