package com.sam.pidash.data.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.sam.pidash.data.remote.pidashJson
import com.sam.pidash.domain.model.VoiceInputPhase
import com.sam.pidash.domain.model.VoiceInputState
import com.sam.pidash.domain.model.appendVoiceTranscript
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

private const val SAMPLE_RATE = 16_000
private const val CHUNK_MILLIS = 100
private const val MAX_PENDING_BYTES = 64 * 1024
private const val TRANSCRIBE_TIMEOUT_MS = 15_000L
private const val POLISH_TIMEOUT_MS = 35_000L

/** One parsed frame from the dashboard's ASR bridge. Unknown fields are deliberately ignored. */
internal sealed interface AsrEvent {
    data object Ready : AsrEvent
    data class Interim(val text: String) : AsrEvent
    data class Final(val text: String) : AsrEvent
    data object Finished : AsrEvent
    data class Failed(val message: String) : AsrEvent
}

internal fun parseAsrEvent(text: String): AsrEvent? {
    val frame = runCatching { pidashJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
    fun string(key: String): String? = (frame[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
    return when (string("type")) {
        "ready" -> AsrEvent.Ready
        "conversation.item.input_audio_transcription.text" ->
            AsrEvent.Interim(string("text").orEmpty() + string("stash").orEmpty())
        "conversation.item.input_audio_transcription.completed" ->
            AsrEvent.Final(string("transcript").orEmpty().trim())
        "conversation.item.input_audio_transcription.failed" ->
            AsrEvent.Failed(string("message") ?: "语音识别失败，请重试。")
        "finished" -> AsrEvent.Finished
        "error" -> AsrEvent.Failed(string("message") ?: "实时语音识别失败，请重试。")
        else -> null
    }
}

/**
 * Records raw 16 kHz mono PCM and streams it to `/api/asr/realtime`.
 *
 * The server owns the DashScope key; this class only sees text frames. Audio bytes live in
 * memory for the length of one utterance and are never written to disk. The caller is
 * responsible for holding RECORD_AUDIO before calling [start].
 */
class VoiceInputController(
    private val openSocket: (WebSocketListener) -> WebSocket,
    private val onTranscript: (String) -> Unit,
    /** Optional post-ASR cleanup; failures/timeouts must fall back to the raw transcript. */
    private val polish: suspend (String) -> String = { it },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val _state = MutableStateFlow(VoiceInputState())
    val state: StateFlow<VoiceInputState> = _state.asStateFlow()

    @Volatile private var socket: WebSocket? = null
    private var recorder: PcmRecorder? = null
    private var timeout: Job? = null
    private val audioLock = Any()
    private val pending = ArrayDeque<ByteArray>()
    private var pendingBytes = 0
    @Volatile private var ready = false
    @Volatile private var capturing = false
    @Volatile private var closed = false
    @Volatile private var finished = false
    private var finalText = ""

    fun toggle() {
        when (_state.value.phase) {
            VoiceInputPhase.Idle -> start()
            VoiceInputPhase.Connecting -> cancel()
            VoiceInputPhase.Listening -> stop()
            VoiceInputPhase.Transcribing -> Unit
        }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (_state.value.phase != VoiceInputPhase.Idle) return
        reset()
        _state.value = VoiceInputState(phase = VoiceInputPhase.Connecting)
        try {
            socket = openSocket(listener)
        } catch (error: Exception) {
            fail(error.message ?: "无法连接语音识别服务")
            return
        }
        if (closed) return
        try {
            recorder = PcmRecorder(
                scope = scope,
                onChunk = ::onAudio,
                onFailure = { message -> if (capturing) fail(message) },
            ).also { it.start() }
        } catch (error: Exception) {
            fail(error.message ?: "无法开始录音")
        }
    }

    /** Stop capturing and ask the provider for its final transcript. */
    fun stop() {
        if (_state.value.phase != VoiceInputPhase.Listening) return
        capturing = false
        recorder?.stop()
        recorder = null
        _state.update { it.copy(phase = VoiceInputPhase.Transcribing, interim = "") }
        synchronized(audioLock) {
            socket?.send(buildJsonObject { put("type", "finish") }.toString())
        }
        timeout = scope.launch {
            delay(TRANSCRIBE_TIMEOUT_MS)
            if (!closed) fail("语音识别超时，请重试")
        }
    }

    fun clearError() {
        if (_state.value.phase == VoiceInputPhase.Idle) _state.update { it.copy(error = null) }
    }

    /** Cancel without replacing the draft; used when the screen leaves the foreground. */
    fun cancel() {
        if (closed) return
        closed = true
        finished = true
        timeout?.cancel()
        cleanup()
        main.removeCallbacksAndMessages(null)
        _state.value = VoiceInputState()
    }

    fun close() {
        cancel()
        scope.cancel()
        main.removeCallbacksAndMessages(null)
    }

    private fun reset() {
        closed = false
        finished = false
        ready = false
        capturing = true
        finalText = ""
        synchronized(audioLock) {
            pending.clear()
            pendingBytes = 0
        }
    }

    @SuppressLint("MissingPermission")
    private val listener = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (closed) return
            when (val event = parseAsrEvent(text)) {
                AsrEvent.Ready -> {
                    ready = true
                    flushPending()
                    if (!closed) _state.update { it.copy(phase = VoiceInputPhase.Listening, error = null) }
                }
                is AsrEvent.Interim -> if (!closed) _state.update { it.copy(interim = event.text) }
                is AsrEvent.Final -> if (!closed && event.text.isNotBlank()) {
                    finalText = appendVoiceTranscript(finalText, event.text)
                    // Keep the finalized segment visible while the user is still recording.
                    // The polished text is appended to the draft only when recording stops,
                    // but clearing this preview made the composer look stuck on "请说话".
                    _state.update { it.copy(interim = finalText) }
                }
                AsrEvent.Finished -> finishWithPolish()
                is AsrEvent.Failed -> fail(event.message)
                null -> Unit
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (closed) return
            val message = when (response?.code) {
                401, 403 -> "没有权限访问语音识别；请检查服务器配置"
                404 -> "服务器还没有语音识别接口；请更新 Dashboard"
                else -> t.message ?: "与语音识别服务的连接中断"
            }
            fail(message)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!closed && !finished) fail("语音识别连接已断开，请重试")
        }
    }

    private fun onAudio(bytes: ByteArray) {
        if (!capturing || closed || bytes.isEmpty()) return
        synchronized(audioLock) {
            if (!capturing || closed) return
            if (!ready) {
                pending.addLast(bytes)
                pendingBytes += bytes.size
                while (pendingBytes > MAX_PENDING_BYTES && pending.isNotEmpty()) {
                    pendingBytes -= pending.removeFirst().size
                }
                return
            }
            sendAudio(bytes)
        }
    }

    private fun flushPending() {
        synchronized(audioLock) {
            if (!capturing || closed) return
            while (pending.isNotEmpty()) sendAudio(pending.removeFirst())
            pendingBytes = 0
        }
    }

    private fun sendAudio(bytes: ByteArray) {
        val audio = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val sent = socket?.send(buildJsonObject {
            put("type", "audio")
            put("audio", audio)
        }.toString()) ?: false
        if (!sent) fail("语音数据发送失败，请重试")
    }

    private fun finishWithPolish() {
        if (closed || finished) return
        finished = true
        timeout?.cancel()
        val raw = finalText.trim()
        cleanup()
        if (raw.isEmpty()) {
            finish("没有识别到语音内容，请靠近麦克风再说一次。")
            return
        }
        _state.update { it.copy(phase = VoiceInputPhase.Transcribing, interim = "") }
        scope.launch {
            val polished = runCatching { withTimeout(POLISH_TIMEOUT_MS) { polish(raw) } }
                .getOrNull()?.trim().orEmpty().ifBlank { raw }
            main.post {
                if (!closed) {
                    onTranscript(polished)
                    finish()
                }
            }
        }
    }

    private fun finish(error: String? = null) {
        if (closed) return
        closed = true
        finished = true
        timeout?.cancel()
        cleanup()
        _state.value = VoiceInputState(phase = VoiceInputPhase.Idle, error = error)
    }

    private fun fail(message: String) {
        if (closed) return
        // A final segment may already have arrived before the socket failed. Keep that
        // recognized text rather than discarding it solely because polish was interrupted.
        val fallback = finalText.trim()
        if (fallback.isNotEmpty() && !finished) main.post { onTranscript(fallback) }
        finish(message)
    }

    private fun cleanup() {
        capturing = false
        ready = false
        synchronized(audioLock) {
            pending.clear()
            pendingBytes = 0
        }
        recorder?.stop()
        recorder = null
        socket?.close(1000, "voice input closed")
        socket = null
    }
}

/** A small read-loop around [AudioRecord]; it never stores audio outside its byte buffer. */
private class PcmRecorder(
    private val scope: CoroutineScope,
    private val onChunk: (ByteArray) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    @Volatile private var running = false
    private var record: AudioRecord? = null
    private var job: Job? = null

    @SuppressLint("MissingPermission")
    fun start() {
        if (job != null) return
        running = true
        job = scope.launch {
            var audio: AudioRecord? = null
            try {
                val min = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                )
                if (min <= 0) throw IllegalStateException("设备不支持录音")
                val chunkBytes = SAMPLE_RATE * 2 * CHUNK_MILLIS / 1000
                val bufferBytes = maxOf(min, chunkBytes)
                audio = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes * 2,
                )
                if (audio.state != AudioRecord.STATE_INITIALIZED) {
                    throw IllegalStateException("麦克风初始化失败")
                }
                record = audio
                audio.startRecording()
                val buffer = ByteArray(bufferBytes)
                while (running && isActive) {
                    val count = audio.read(buffer, 0, buffer.size)
                    when {
                        count > 0 -> onChunk(buffer.copyOf(count))
                        count < 0 -> throw IllegalStateException("读取麦克风失败")
                    }
                }
            } catch (error: Exception) {
                if (running) onFailure(error.message ?: "录音失败，请检查麦克风权限")
            } finally {
                running = false
                runCatching { audio?.stop() }
                runCatching { audio?.release() }
                if (record === audio) record = null
            }
        }
    }

    fun stop() {
        running = false
        runCatching { record?.stop() }
        job?.cancel()
        job = null
    }
}