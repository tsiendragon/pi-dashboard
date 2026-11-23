package com.sam.pidash.ui.live

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

/** One renderer and its owning file descriptor; close only from the composition that opened it. */
private class PdfDocument(
    val file: File,
    val descriptor: ParcelFileDescriptor,
    val renderer: PdfRenderer,
) {
    val pageCount: Int get() = renderer.pageCount
    val mutex = Mutex()

    fun close() {
        runCatching { renderer.close() }
        runCatching { descriptor.close() }
        file.delete()
    }
}

@Composable
private fun PdfPage(document: PdfDocument, index: Int) {
    var image by remember(document, index) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    var error by remember(document, index) { mutableStateOf<String?>(null) }
    LaunchedEffect(document, index) {
        try {
            val bitmap = withContext(Dispatchers.IO) {
                document.mutex.withLock {
                    document.renderer.openPage(index).use { page ->
                        if (page.width <= 0 || page.height <= 0) throw IllegalStateException("PDF 页面尺寸无效")
                        val scale = minOf(1080f / page.width, 2048f / page.height, 2f)
                        val width = (page.width * scale).roundToInt().coerceAtLeast(1)
                        val height = (page.height * scale).roundToInt().coerceAtLeast(1)
                        val rendered = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        rendered.eraseColor(AndroidColor.WHITE)
                        page.render(rendered, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        rendered
                    }
                }
            }
            image = bitmap.asImageBitmap()
        } catch (failure: Throwable) {
            error = failure.message ?: "这一页无法渲染"
        }
    }
    if (error != null) {
        Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("第 ${index + 1} 页：${error}", style = PiType.footnote, color = MaterialTheme.colorScheme.error)
        }
    } else {
        val current = image
        if (current == null) {
            Box(
                Modifier.fillMaxWidth().height(360.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        } else {
            Image(
                bitmap = current,
                contentDescription = "PDF 第 ${index + 1} 页",
                modifier = Modifier.fillMaxWidth(),
                contentScale = ContentScale.FillWidth,
            )
        }
    }
}

/** In-app PDF viewer: pages render to bitmaps, so no external PDF app or file URL is needed. */
@Composable
internal fun PdfPreviewDialog(path: String, bytes: ByteArray, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var document by remember(path) { mutableStateOf<PdfDocument?>(null) }
    var error by remember(path) { mutableStateOf<String?>(null) }
    val latestDocument by rememberUpdatedState(document)
    DisposableEffect(path) { onDispose { latestDocument?.close() } }
    LaunchedEffect(path, bytes) {
        document?.close()
        document = null
        error = null
        val (loaded, failure) = withContext(Dispatchers.IO) {
            runCatching {
                val file = File.createTempFile("pidash-preview-", ".pdf", context.cacheDir)
                var descriptor: ParcelFileDescriptor? = null
                try {
                    file.writeBytes(bytes)
                    val opened = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                    descriptor = opened
                    PdfDocument(file, opened, PdfRenderer(opened))
                } catch (failure: Throwable) {
                    runCatching { descriptor?.close() }
                    file.delete()
                    throw failure
                }
            }.fold(
                onSuccess = { it to null },
                onFailure = { null to (it.message ?: "无法打开 PDF") },
            )
        }
        document = loaded
        error = failure
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SelectionContainer { Text(path, Modifier.weight(1f), style = PiType.action, maxLines = 2) }
                    TextButton(onClick = onDismiss) { Text("关闭") }
                }
                HorizontalDivider()
                val current = document
                when {
                    error != null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Text(error!!, style = PiType.footnote, color = MaterialTheme.colorScheme.error)
                    }
                    current == null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                            Text("正在打开 PDF…", style = PiType.footnote)
                        }
                    }
                    current.pageCount == 0 -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Text("PDF 没有页面", style = PiType.footnote)
                    }
                    else -> LazyColumn(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = PaddingValues(vertical = Spacing.sm),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        items(current.pageCount) { index -> PdfPage(current, index) }
                    }
                }
            }
        }
    }
}
