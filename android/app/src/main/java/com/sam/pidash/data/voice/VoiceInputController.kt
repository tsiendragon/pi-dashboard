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

/**
 * Deadlines of one controller. [connect] covers `Connecting` until the provider's `ready`;
 * [transcribe] waits for `finished` after [VoiceInputController.stop]; [polish] bounds cleanup.
 * Internal so timeout tests can shrink them: Robolectric's main-looper clock does not advance
 * coroutines on Dispatchers.IO, so tests poll real time instead of faking it.
 */
internal data class VoiceTimeouts(
    val connect: Long = 15_000L,
    val transcribe: Long = 15_000L,
    val polish: Long = 35_000L,
)

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
 *
 * Every [start] opens a new session generation and installs its own [WebSocketListener], so a
 * late `onMessage`/`onFailure`/`onClosed`, timeout or polish callback from an earlier attempt can
 * never change the state of the current one. The provider ends a session only on
 * `session.finish`; a VAD pause does not, so there is deliberately no reconnect/retry here —
 * a broken session surfaces as an error and the user decides whether to start again.
 */
class VoiceInputController internal constructor(
    private val openSocket: (WebSocketListener) -> WebSocket,
    private val onTranscript: (String) -> Unit,
    /** Optional post-ASR cleanup; failures/timeouts must fall back to the raw transcript. */
    private val polish: suspend (String) -> String = { it },
    /** Tiny technical/context corpus sent before audio; null/blank disables biasing. */
    private val context: () -> String? = { null },
    private val timeouts: VoiceTimeouts = VoiceTimeouts(),
) {
    /** Mutable state owned by exactly one [start] attempt; discarded with that generation. */
    private class Session(val generation: Long) {
        var socket: WebSocket? = null
        var recorder: PcmRecorder? = null
        /** Connection deadline, cancelled by `ready`, finish or cancel. */
        var connectionTimeout: Job? = null
        var timeout: Job? = null
        var polishJob: Job? = null
        val pending = ArrayDeque<ByteArray>()
        var pendingBytes = 0
        @Volatile var ready = false
        @Volatile var capturing = true
        @Volatile var closed = false
        /** Set when the user cancels: no queued callback of this attempt may touch the draft. */
        @Volatile var discarded = false
        @Volatile var finished = false
        /** Written by the socket thread and read by stop/cancel; keep it visible across threads. */
        @Volatile var finalText = ""
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val main = Handler(Looper.getMainLooper())
    private val _state = MutableStateFlow(VoiceInputState())
    val state: StateFlow<VoiceInputState> = _state.asStateFlow()

    private val audioLock = Any()
    /** Bumped on every [start]; stale callbacks are recognised by a smaller generation. */
    @Volatile private var generation = 0L
    @Volatile private var active: Session? = null

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
        val session = Session(++generation)
        active = session
        _state.value = VoiceInputState(phase = VoiceInputPhase.Connecting)
        // Arm the deadline before opening: a socket that never reports `ready` (unreachable
        // server, stalled upstream handshake) must not leave the composer stuck in Connecting.
        session.connectionTimeout = scope.launch {
            delay(timeouts.connect)
            if (isLive(session) && !session.ready) fail(session, "连接语音识别服务超时，请重试")
        }
        try {
            session.socket = openSocket(listenerFor(session))
        } catch (error: Exception) {
            fail(session, error.message ?: "无法连接语音识别服务")
            return
        }
        if (!isLive(session)) return
        // Send contextual-biasing text before the first audio chunk. It travels over
        // the existing authenticated socket, not a URL/query, so it is not put in
        // access logs. The server passes it to Qwen as input_audio_transcription.corpus.
        runCatching {
            context()?.trim()?.takeIf { it.isNotEmpty() }?.let { text ->
                session.socket?.send(buildJsonObject {
                    put("type", "context")
                    put("text", text.take(3_500))
                }.toString())
            }
        }
        try {
            session.recorder = PcmRecorder(
                scope = scope,
                onChunk = { bytes -> onAudio(session, bytes) },
                onFailure = { message -> if (session.capturing) fail(session, message) },
            ).also { it.start() }
        } catch (error: Exception) {
            fail(session, error.message ?: "无法开始录音")
        }
    }

    /** Stop capturing and ask the provider for its final transcript. */
    fun stop() {
        val session = active ?: return
        if (_state.value.phase != VoiceInputPhase.Listening || session.closed) return
        // Claim the capture slot only while the round is live. A socket callback may close the
        // session while we are in here; after that stop must not write any state again.
        val stopping = synchronized(audioLock) {
            if (!isLive(session)) {
                false
            } else {
                session.capturing = false
                true
            }
        }
        if (!stopping) return
        session.recorder?.stop()
        session.recorder = null
        val socket = session.socket
        val sent = socket != null && runCatching {
            socket.send(buildJsonObject { put("type", "finish") }.toString())
        }.getOrDefault(false)
        if (!sent || !isLive(session)) {
            // The socket already went away: close the utterance with what was recognised
            // instead of waiting for a `finished` frame that can no longer arrive.
            finishWithPolish(session)
            return
        }
        // `finish`/`fail` may already have returned the round to Idle (possibly from inside the
        // send above). Only a still-live session enters Transcribing, so the UI can never be
        // left there waiting for a `finished` frame that was already consumed.
        _state.update {
            if (isLive(session)) it.copy(phase = VoiceInputPhase.Transcribing, interim = "") else it
        }
        if (!isLive(session)) return
        session.timeout = scope.launch {
            delay(timeouts.transcribe)
            if (isLive(session)) fail(session, "语音识别超时，请重试")
        }
    }

    fun clearError() {
        if (_state.value.phase == VoiceInputPhase.Idle) _state.update { it.copy(error = null) }
    }

    /** Cancel without replacing the draft; used when the screen leaves the foreground. */
    fun cancel() {
        val session = active ?: return
        if (session.generation != generation || session.closed) return
        session.discarded = true
        session.closed = true
        session.finished = true
        session.timeout?.cancel()
        session.connectionTimeout?.cancel()
        session.connectionTimeout = null
        session.polishJob?.cancel()
        cleanup(session)
        active = null
        _state.value = VoiceInputState()
    }

    fun close() {
        cancel()
        scope.cancel()
    }

    private fun isLive(session: Session): Boolean =
        session.generation == generation && active === session && !session.closed

    private fun listenerFor(session: Session) = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isLive(session)) return
            when (val event = parseAsrEvent(text)) {
                AsrEvent.Ready -> {
                    session.ready = true
                    // Ready is the one event that ends the connection deadline for this session.
                    session.connectionTimeout?.cancel()
                    session.connectionTimeout = null
                    flushPending(session)
                    if (isLive(session)) _state.update { it.copy(phase = VoiceInputPhase.Listening, error = null) }
                }
                is AsrEvent.Interim -> if (isLive(session)) _state.update { it.copy(interim = event.text) }
                is AsrEvent.Final -> if (isLive(session) && event.text.isNotBlank()) {
                    session.finalText = appendVoiceTranscript(session.finalText, event.text)
                    // Keep the finalized segment visible while the user is still recording.
                    // The polished text is appended to the draft only when recording stops,
                    // but clearing this preview made the composer look stuck on "请说话".
                    _state.update { it.copy(interim = session.finalText) }
                }
                AsrEvent.Finished -> finishWithPolish(session)
                is AsrEvent.Failed -> fail(session, event.message)
                null -> Unit
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!isLive(session)) return
            val message = when (response?.code) {
                401, 403 -> "没有权限访问语音识别；请检查服务器配置"
                404 -> "服务器还没有语音识别接口；请更新 Dashboard"
                else -> t.message ?: "与语音识别服务的连接中断"
            }
            fail(session, message)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (isLive(session) && !session.finished) fail(session, "语音识别连接已断开，请重试")
        }
    }

    private fun onAudio(session: Session, bytes: ByteArray) {
        if (!session.capturing || bytes.isEmpty() || !isLive(session)) return
        synchronized(audioLock) {
            if (!session.capturing || !isLive(session)) return
            if (!session.ready) {
                session.pending.addLast(bytes)
                session.pendingBytes += bytes.size
                while (session.pendingBytes > MAX_PENDING_BYTES && session.pending.isNotEmpty()) {
                    session.pendingBytes -= session.pending.removeFirst().size
                }
                return
            }
            sendAudio(session, bytes)
        }
    }

    private fun flushPending(session: Session) {
        synchronized(audioLock) {
            if (!session.capturing || !isLive(session)) return
            while (session.pending.isNotEmpty()) sendAudio(session, session.pending.removeFirst())
            session.pendingBytes = 0
        }
    }

    private fun sendAudio(session: Session, bytes: ByteArray) {
        val audio = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val sent = session.socket?.send(buildJsonObject {
            put("type", "audio")
            put("audio", audio)
        }.toString()) ?: false
        if (!sent) fail(session, "语音数据发送失败，请重试")
    }

    /**
     * Claims the single finish transition of [session]. Returns false when another path
     * (this attempt's `finished`, stop, cancel, or a newer generation) already closed it, so a
     * duplicate `finished` frame can never polish twice or clear a newer round.
     */
    private fun claimFinish(session: Session): Boolean = synchronized(audioLock) {
        if (!isLive(session) || session.finished) {
            false
        } else {
            session.finished = true
            session.timeout?.cancel()
            true
        }
    }

    private fun finishWithPolish(session: Session) {
        if (!claimFinish(session)) return
        val raw = session.finalText.trim()
        cleanup(session)
        if (raw.isEmpty()) {
            finish(session, "没有识别到语音内容，请靠近麦克风再说一次。")
            return
        }
        _state.update { it.copy(phase = VoiceInputPhase.Transcribing, interim = "") }
        session.polishJob = scope.launch {
            val polished = runCatching { withTimeout(timeouts.polish) { polish(raw) } }
                .getOrNull()?.trim().orEmpty().ifBlank { raw }
            main.post {
                if (session.generation == generation && !session.discarded) {
                    onTranscript(polished)
                    finish(session)
                }
            }
        }
    }

    private fun finish(session: Session, error: String? = null) {
        if (session.generation != generation) return
        session.closed = true
        session.finished = true
        session.timeout?.cancel()
        session.connectionTimeout?.cancel()
        session.connectionTimeout = null
        cleanup(session)
        active = null
        _state.value = VoiceInputState(phase = VoiceInputPhase.Idle, error = error)
    }

    private fun fail(session: Session, message: String) {
        if (!isLive(session)) return
        // A final segment may already have arrived before the socket failed. Keep that
        // recognized text rather than discarding it solely because polish was interrupted.
        val fallback = session.finalText.trim()
        if (fallback.isNotEmpty() && !session.finished) {
            // Mark the round finished before handing off the text: a concurrent stop() then sees
            // a closed session (claimFinish returns false) instead of polishing the same text
            // twice. The post itself cannot be interrupted, so the text is not lost either.
            session.finished = true
            main.post {
                if (session.generation == generation && !session.discarded) onTranscript(fallback)
            }
        }
        finish(session, message)
    }

    /** Releases resources of [session] only; never touches state owned by a newer attempt. */
    private fun cleanup(session: Session) {
        session.capturing = false
        session.ready = false
        synchronized(audioLock) {
            session.pending.clear()
            session.pendingBytes = 0
        }
        session.recorder?.stop()
        session.recorder = null
        session.socket?.close(1000, "voice input closed")
        session.socket = null
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