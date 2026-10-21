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
}
