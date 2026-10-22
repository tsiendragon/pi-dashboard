package com.sam.pidash.data.remote

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.sam.pidash.domain.model.LiveImage
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * Image attachments for Live input.
 *
 * Limits mirror `shared/src/live-sessions.ts` exactly (3 MiB each, 4 images,
 * 6 MiB total) so the server never has to reject a message the UI allowed.
 * `validate` is pure and unit tested; only `read` touches Android APIs.
 */
internal object ImageAttachments {
    const val MAX_IMAGE_BYTES = 3 * 1024 * 1024
    const val MAX_IMAGES = 4
    const val MAX_TOTAL_BYTES = 6 * 1024 * 1024
    private const val MAX_SOURCE_BYTES = 24 * 1024 * 1024
    private const val MAX_EDGE = 2048

    val ALLOWED_MIMES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    /** `image/jpg`, `image/x-png` and extension-only names are all real-world cases. */
    fun normalizeMime(type: String?, name: String? = null): String? {
        val clean = type?.lowercase()?.substringBefore(';')?.trim().orEmpty()
        if (clean in ALLOWED_MIMES) return clean
        if (clean == "image/jpg" || clean == "image/pjpeg") return "image/jpeg"
        if (clean == "image/x-png") return "image/png"
        val extension = name?.substringAfterLast('.', "")?.lowercase().orEmpty()
        return when (extension) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            else -> null
        }
    }

    /** Some providers hand out `application/octet-stream`; the file signature is the truth. */
    fun sniffMime(bytes: ByteArray): String? {
        fun starts(vararg prefix: Int): Boolean =
            bytes.size >= prefix.size && prefix.indices.all { bytes[it] == prefix[it].toByte() }
        return when {
            starts(0x89, 0x50, 0x4E, 0x47) -> "image/png"
            starts(0xFF, 0xD8, 0xFF) -> "image/jpeg"
            starts(0x47, 0x49, 0x46, 0x38) -> "image/gif"
            bytes.size >= 12 && starts(0x52, 0x49, 0x46, 0x46) &&
                String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" -> "image/webp"
            else -> null
        }
    }

    /** Returns a user-facing reason, or null when the set is sendable. */
    fun validate(images: List<LiveImage>): String? {
        if (images.size > MAX_IMAGES) return "最多附加 $MAX_IMAGES 张图片"
        var total = 0L
        for (image in images) {
            if (image.mimeType !in ALLOWED_MIMES) return "只支持 PNG/JPEG/WebP/GIF 图片"
            if (image.data.isBlank()) return "图片内容为空"
            // Base64 length maps back to raw bytes without decoding.
            val bytes = image.data.length.toLong() * 3 / 4
            if (bytes > MAX_IMAGE_BYTES) return "单张图片不能超过 3 MB"
            total += bytes
        }
        return if (total > MAX_TOTAL_BYTES) "图片合计不能超过 6 MB" else null
    }

    fun read(context: Context, uri: Uri): Result<LiveImage> = runCatching {
        val name = FileAttachments.displayName(context, uri)
        // Never trust the provider's mime alone: fall back to the name, then to the bytes.
        val declared = normalizeMime(context.contentResolver.getType(uri), name)
        val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IOException("无法读取这张图片")
        val type = declared ?: sniffMime(raw) ?: throw IOException("只支持 PNG/JPEG/WebP/GIF 图片")
        if (raw.size > MAX_SOURCE_BYTES) throw IOException("图片过大，请先裁剪再附加")
        if (raw.size <= MAX_IMAGE_BYTES) {
            // Already sendable: keep the original bytes, so WebP/GIF stay intact.
            LiveImage(type, Base64.encodeToString(raw, Base64.NO_WRAP))
        } else {
            downscale(raw)
        }
    }

    private fun downscale(raw: ByteArray): LiveImage {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("无法解码这张图片")
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= MAX_EDGE && bounds.outHeight / (sample * 2) >= MAX_EDGE) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IOException("无法解码这张图片")
        try {
            val out = ByteArrayOutputStream()
            var quality = 88
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            while (out.size() > MAX_IMAGE_BYTES && quality > 40) {
                out.reset()
                quality -= 12
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
            }
            if (out.size() > MAX_IMAGE_BYTES) throw IOException("压缩后仍超过 3 MB，请先裁剪")
            return LiveImage("image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
        } finally {
            bitmap.recycle()
        }
    }
}