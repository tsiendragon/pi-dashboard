package com.sam.pidash.ui.live

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.sam.pidash.domain.model.LiveTimelineItem
import com.sam.pidash.data.remote.externalUrlAllowed
import com.sam.pidash.data.remote.pathVisibleInTranscript
import com.sam.pidash.data.remote.transcriptPayload
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicReference

/**
 * Renders the transcript with the WebUI's own React renderer instead of a second
 * Kotlin implementation.
 *
 * The bundle lives in `assets/native-renderer` (built by
 * `npm run build:native-renderer`). It is served to the WebView from a private
 * virtual origin through `shouldInterceptRequest`, so ES modules and lazy mermaid
 * chunks work without `androidx.webkit`, and every other request — network or
 * file — is refused. The page holds no cookie and makes no request of its own.
 */
internal object NativeRenderAssets {
    const val HOST = "renderer.pidash.local"
    const val ROOT = "native-renderer"

    private val TYPES = mapOf(
        "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript",
        "css" to "text/css", "json" to "application/json", "svg" to "image/svg+xml",
        "png" to "image/png", "jpg" to "image/jpeg", "woff" to "font/woff", "woff2" to "font/woff2",
        "ttf" to "font/ttf", "map" to "application/json",
    )

    fun mime(path: String): String = TYPES[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
}

/**
 * The only channel from the renderer page back into the app.
 *
 * It can *request* a file preview and nothing else: the request is refused unless
 * the path already appears in the transcript currently on screen, so rendered
 * content cannot reach files the reader has not seen.
 */
class TranscriptBridge(
    private val transcript: AtomicReference<String>,
    private val openPath: (String) -> Unit,
    private val openUrl: (String) -> Unit,
) {
    @JavascriptInterface
    fun openPath(path: String) {
        if (pathVisibleInTranscript(transcript.get(), path)) openPath(path)
    }

    /** Only http(s) leaves the app; the caller re-validates before starting an Intent. */
    @JavascriptInterface
    fun openUrl(url: String) {
        val candidate = url.trim()
        if (candidate.length in 1..4096 && externalUrlAllowed(candidate) && transcript.get().contains(candidate)) {
            openUrl(candidate)
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun NativeTranscriptView(
    items: List<LiveTimelineItem>,
    dark: Boolean,
    emptyText: String,
    modifier: Modifier = Modifier,
    onFailure: (String) -> Unit = {},
    onOpenPath: ((String) -> Unit)? = null,
    onOpenUrl: ((String) -> Unit)? = null,
) {
    val payload = remember(items, dark, emptyText) { transcriptPayload(items, dark, emptyText) }
    // What the bridge may open is exactly what is rendered right now.
    val transcriptRef = remember { AtomicReference(payload) }
    SideEffect { transcriptRef.set(payload) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var pageReady by remember { mutableStateOf(false) }

    fun blocked() = WebResourceResponse(
        "text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )

    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(Color.TRANSPARENT)
                settings.apply {
                    javaScriptEnabled = true
                    // No storage, no file:// and no zoom: the page is a bundled asset.
                    domStorageEnabled = false
                    allowFileAccess = false
                    allowContentAccess = false
                    setSupportZoom(false)
                    useWideViewPort = false
                    loadWithOverviewMode = false
                    builtInZoomControls = false
                    displayZoomControls = false
                    textZoom = 100
                    cacheMode = WebSettings.LOAD_NO_CACHE
                    mediaPlaybackRequiresUserGesture = true
                }
                // Long-press selection is wanted; contextual menus could leak a URL.
                isLongClickable = true
                // The transcript only scrolls vertically. Without this a wide code
                // block lets the WebView pan the whole page sideways.
                overScrollMode = android.view.View.OVER_SCROLL_NEVER
                isHorizontalScrollBarEnabled = false
                isVerticalScrollBarEnabled = false
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                        val url = request.url
                        if (url.scheme != "https" || url.host != NativeRenderAssets.HOST) return blocked()
                        val path = url.path.orEmpty().trimStart('/').ifBlank { "index.html" }
                        if (path.contains("..")) return blocked()
                        return try {
                            val bytes = context.assets.open("${NativeRenderAssets.ROOT}/$path").use { it.readBytes() }
                            WebResourceResponse(NativeRenderAssets.mime(path), "utf-8", 200, "OK",
                                mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(bytes))
                        } catch (missing: Exception) {
                            blocked()
                        }
                    }

                    override fun onPageFinished(view: WebView, url: String) { pageReady = true }

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                        if (request.isForMainFrame) onFailure(error.description?.toString() ?: "渲染页加载失败")
                    }

                    override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                        web = null
                        onFailure("渲染进程已退出；请切到「完整对话」继续阅读。")
                        return true
                    }
                }
                if (onOpenPath != null || onOpenUrl != null) {
                    addJavascriptInterface(
                        TranscriptBridge(transcriptRef, { path -> onOpenPath?.invoke(path) }, { url -> onOpenUrl?.invoke(url) }),
                        "PiDashNative",
                    )
                }
                loadUrl("https://${NativeRenderAssets.HOST}/index.html")
                web = this
            }
        },
        update = { view -> web = view },
    )

    LaunchedEffect(payload, pageReady, web) {
        val target = web ?: return@LaunchedEffect
        if (!pageReady) return@LaunchedEffect
        // JSONObject.quote escapes the payload into a safe JS string literal.
        target.evaluateJavascript(
            "window.PiDashRenderer && window.PiDashRenderer.render(${JSONObject.quote(payload)})", null,
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            web?.removeJavascriptInterface("PiDashNative")
            web?.destroy()
            web = null
        }
    }
}