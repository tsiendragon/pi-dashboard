package com.sam.pidash.data.remote

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import com.sam.pidash.domain.model.LiveImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Attachments other than images.
 *
 * The WebUI only sends the *path* of a dropped file because the file sits on the
 * agent's own machine. A phone file is not on that machine, so text files are
 * inlined as one fenced block (with an explicit truncation note) and a PDF is
 * rasterised into ordinary image parts — the two shapes the Live protocol
 * already accepts, so no server change is involved.
 */
object FileAttachments {
    const val MAX_FILES = 3
    /** Per-file inline cap; the whole prompt must stay under the 128 KiB limit. */
    const val MAX_FILE_BYTES = 32 * 1024
    const val MAX_TOTAL_BYTES = 96 * 1024
    const val MAX_PDF_PAGES = 4
    private const val PDF_RENDER_WIDTH = 1240
    private const val PDF_JPEG_QUALITY = 80

    /** Text types worth inlining; anything else is refused rather than guessed. */
    val TEXT_EXTENSIONS = setOf(
        "md", "markdown", "mdx", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "cfg", "env",
        "csv", "tsv", "txt", "log", "py", "sh", "bash", "zsh", "ts", "tsx", "js", "jsx", "sql",
        "xml", "html", "css", "scss", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp",
        "rb", "php", "lua", "tf", "gradle", "properties", "diff", "patch",
    )

    fun extensionOf(name: String): String = name.substringAfterLast('.', "").lowercase()

    fun isTextFile(name: String): Boolean = extensionOf(name) in TEXT_EXTENSIONS

    fun isPdf(name: String): Boolean = extensionOf(name) == "pdf"

    fun isSupported(name: String): Boolean = isTextFile(name) || isPdf(name)

    /**
     * The file picker also lists photos, so accept them by mime type or by name and hand
     * them to the image pipeline instead of refusing with "unsupported type".
     */
    fun isImage(name: String, mime: String? = null): Boolean {
        if (ImageAttachments.normalizeMime(mime, name) != null) return true
        return extensionOf(name) in setOf("png", "jpg", "jpeg", "webp", "gif")
    }

    data class TextAttachment(
        val name: String,
        val text: String,
        val sizeBytes: Int,
        val truncated: Boolean,
    )

    /** Decode UTF-8 text; a NUL byte means binary and is refused, never mangled. */
    fun decodeText(bytes: ByteArray): String? {
        if (bytes.isEmpty()) return ""
        if (bytes.any { it == 0.toByte() }) return null
        val text = bytes.toString(Charsets.UTF_8)
        val controls = text.count { it.isISOControl() && it != '\n' && it != '\r' && it != '\t' }
        if (controls > text.length / 50) return null
        return text
    }

    fun validate(files: List<TextAttachment>): String? = when {
        files.size > MAX_FILES -> "最多附加 $MAX_FILES 个文本文件"
        files.sumOf { it.sizeBytes } > MAX_TOTAL_BYTES -> "附件合计超出 ${MAX_TOTAL_BYTES / 1024} KB"
        files.any { it.text.isEmpty() } -> "存在空文件"
        else -> null
    }

    fun humanSize(bytes: Int): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> String.format("%.1f KB", bytes / 1024.0)
        else -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
    }

    /**
     * One fenced block per file, headed by name and size so the agent knows what
     * it is reading. Truncation is stated instead of silently cutting the file.
     */
    fun prefix(files: List<TextAttachment>): String = files.joinToString("\n\n") { file ->
        val fence = "```"
        val language = extensionOf(file.name)
        val note = if (file.truncated) "，已截断：只发送前 ${MAX_FILE_BYTES / 1024} KB" else ""
        "文件：${file.name}（${humanSize(file.sizeBytes)}$note）\n$fence$language\n${file.text.trimEnd()}\n$fence"
    }

    suspend fun readText(context: Context, uri: Uri): Result<TextAttachment> = withContext(Dispatchers.IO) {
        runCatching {
            val name = displayName(context, uri)
            if (!isTextFile(name)) throw IllegalArgumentException("不支持的文件类型：$name")
            val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: throw IllegalArgumentException("无法读取 $name")
            val text = decodeText(bytes) ?: throw IllegalArgumentException("$name 看起来是二进制文件")
            val cut = text.length > MAX_FILE_BYTES
            TextAttachment(
                name = name,
                text = if (cut) text.take(MAX_FILE_BYTES) else text,
                sizeBytes = bytes.size,
                truncated = cut,
            )
        }
    }

    /** PDF pages become normal image parts: readable, and within the protocol limits. */
    suspend fun pdfPages(context: Context, uri: Uri): Result<List<LiveImage>> = withContext(Dispatchers.IO) {
        runCatching {
            val name = displayName(context, uri)
            if (!isPdf(name)) throw IllegalArgumentException("不是 PDF：$name")
            val descriptor: ParcelFileDescriptor = context.contentResolver.openFileDescriptor(uri, "r")
                ?: throw IllegalArgumentException("无法读取 $name")
            descriptor.use { pdf ->
                PdfRenderer(pdf).use { renderer ->
                    val pages = minOf(renderer.pageCount, MAX_PDF_PAGES)
                    if (pages == 0) throw IllegalArgumentException("$name 没有页面")
                    (0 until pages).map { index ->
                        renderer.openPage(index).use { page ->
                            val width = PDF_RENDER_WIDTH
                            val height = (width.toFloat() * page.height / page.width).toInt().coerceAtLeast(1)
                            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                            // PDF pages are transparent by default; white avoids black backgrounds.
                            bitmap.eraseColor(Color.WHITE)
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            val out = ByteArrayOutputStream()
                            bitmap.compress(Bitmap.CompressFormat.JPEG, PDF_JPEG_QUALITY, out)
                            bitmap.recycle()
                            val data = out.toByteArray()
                            if (data.size > ImageAttachments.MAX_IMAGE_BYTES) {
                                throw IllegalArgumentException("$name 第 ${index + 1} 页过大，无法发送")
                            }
                            LiveImage("image/jpeg", Base64.getEncoder().encodeToString(data))
                        }
                    }
                }
            }
        }
    }

    fun displayName(context: Context, uri: Uri): String {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) cursor.getString(index)?.takeIf { it.isNotBlank() }?.let { return it }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "文件"
    }
}
