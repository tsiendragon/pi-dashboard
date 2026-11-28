package com.sam.pidash.data.voice

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.domain.model.VoiceInputPhase
import com.sam.pidash.domain.model.VoiceInputState
import com.sam.pidash.domain.model.appendVoiceTranscript
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/** A socket the test drives by hand; it records frames but never talks to a server. */
private class FakeSocket : WebSocket {
    val sent = mutableListOf<String>()
    var open = true

    /**
     * Runs synchronously inside [send]: tests use it to deliver a socket callback while the
     * controller is still inside its own `send` call (the real race window).
     */
    var onSend: ((json: String) -> Unit)? = null

    override fun request() = throw UnsupportedOperationException()
    override fun queueSize() = 0L
    override fun send(text: String): Boolean {
        if (!open) return false
        sent += text
        onSend?.invoke(text)
        return true
    }
    override fun send(bytes: okio.ByteString): Boolean = true
    override fun close(code: Int, reason: String?): Boolean { open = false; return true }
    override fun cancel() { open = false }
}

/** Drives the real controller on Robolectric's main looper with fake sockets. */
private class Harness(
    polish: suspend (String) -> String = { it },
    timeouts: VoiceTimeouts = VoiceTimeouts(),
) {
    val sockets = mutableListOf<FakeSocket>()
    val listeners = mutableListOf<WebSocketListener>()
    val transcripts = mutableListOf<String>()
    val controller = VoiceInputController(
        openSocket = { listener ->
            FakeSocket().also { sockets += it; listeners += listener }
        },
        onTranscript = { transcripts += it },
        polish = polish,
        context = { null },
        timeouts = timeouts,
    )

    val state: VoiceInputState get() = controller.state.value
    val phase: VoiceInputPhase get() = state.phase

    /** Pumps the main looper so `_state` / `main.post` updates are visible. */
    fun settle(): Harness {
        shadowOf(Looper.getMainLooper()).idle()
        return this
    }

    fun advance(millis: Long): Harness {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis))
        return this
    }

    /** Waits for work that runs on Dispatchers.IO, then pumps the main looper again. */
    fun awaitUntil(what: String, timeoutMs: Long = 3_000, condition: () -> Boolean): Harness {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            settle()
            if (condition()) return this
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $what; phase=$phase state=$state transcripts=$transcripts")
    }

    /** Yields real time without asserting, for negative checks ("nothing happened in time X"). */
    fun pollFor(millis: Long): Harness {
        val deadline = System.currentTimeMillis() + millis
        while (System.currentTimeMillis() < deadline) {
            settle()
            Thread.sleep(10)
        }
        return this
    }

    fun send(index: Int, json: String) {
        listeners[index].onMessage(sockets[index], json)
        settle()
    }

    fun ready(index: Int) = send(index, """{"type":"ready"}""")
    fun final(index: Int, text: String) = send(
        index,
        """{"type":"conversation.item.input_audio_transcription.completed","transcript":"$text"}""",
    )
    fun finished(index: Int) = send(index, """{"type":"finished"}""")

    fun closedEvent(index: Int) = listeners[index].onClosed(sockets[index], 1000, "closed")
    fun failureEvent(index: Int) =
        listeners[index].onFailure(sockets[index], RuntimeException("stale round"), null as Response?)
}

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class VoiceInputTest {
    @Test fun transcriptAppendsWithoutDestroyingTheDraft() {
        assertEquals("帮我看下", appendVoiceTranscript("", "帮我看下"))
        assertEquals("先看 README 帮我看下", appendVoiceTranscript("先看 README", "帮我看下"))
        assertEquals("先看 README\n帮我看下", appendVoiceTranscript("先看 README\n", "帮我看下"))
        assertEquals("draft", appendVoiceTranscript("draft", "  "))
    }

    @Test fun parsesTheRealtimeBridgeFrames() {
        assertEquals(AsrEvent.Ready, parseAsrEvent("""{"type":"ready"}"""))
        assertEquals(
            AsrEvent.Interim("帮我 check"),
            parseAsrEvent("""{"type":"conversation.item.input_audio_transcription.text","text":"帮我 ","stash":"check"}"""),
        )
        assertEquals(
            AsrEvent.Final("帮我 check 这个 API"),
            parseAsrEvent("""{"type":"conversation.item.input_audio_transcription.completed","transcript":" 帮我 check 这个 API "}"""),
        )
        assertEquals(AsrEvent.Finished, parseAsrEvent("""{"type":"finished"}"""))
        assertEquals(
            AsrEvent.Failed("没有识别到语音内容"),
            parseAsrEvent("""{"type":"error","message":"没有识别到语音内容"}"""),
        )
    }

    @Test fun ignoresMalformedAndUnknownFrames() {
        assertNull(parseAsrEvent("not json"))
        assertNull(parseAsrEvent("""{"type":"future.event"}"""))
        assertNull(parseAsrEvent("""{"type":42}"""))
    }

    @Test fun staleSocketEventsFromAnEarlierRoundCannotTouchTheNewRound() {
        val harness = Harness()
        harness.controller.start()
        harness.ready(0)
        assertEquals(VoiceInputPhase.Listening, harness.phase)

        // Cancelling closes round 0; its listener may still deliver callbacks afterwards.
        harness.controller.cancel()
        assertEquals(VoiceInputPhase.Idle, harness.phase)

        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)
        harness.ready(0)
        harness.closedEvent(0)
        harness.failureEvent(0)
        harness.settle()
        // Round 0's ready/close/failure must not drive or fail round 1.
        assertEquals("", harness.state.interim)
        assertNull(harness.state.error)

        harness.ready(1)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
        assertNull(harness.state.error)
        assertEquals(2, harness.sockets.size)
    }

    @Test fun oldFinishedFrameAndOldTimeoutCannotEndTheNewRound() {
        val harness = Harness()
        harness.controller.start()
        harness.ready(0)
        harness.controller.stop()
        assertEquals(VoiceInputPhase.Transcribing, harness.phase)

        // Round 0 never finishes; the user cancels and starts a fresh round.
        harness.controller.cancel()
        harness.controller.start()
        harness.ready(1)
        assertEquals(VoiceInputPhase.Listening, harness.phase)

        harness.finished(0)
        harness.closedEvent(0)
        // Round 0's transcribe timeout must not fire into round 1 either.
        harness.pollFor(80)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
        assertNull(harness.state.error)
        assertTrue(harness.transcripts.isEmpty())
    }

    @Test fun stopAndFinishPolishExactlyOnceAndReturnToIdle() {
        val harness = Harness(polish = { "polished:$it" })
        harness.controller.start()
        harness.ready(0)
        harness.final(0, "帮我看下")
        harness.controller.stop()
        assertEquals(VoiceInputPhase.Transcribing, harness.phase)

        harness.finished(0)
        harness.finished(0)
        harness.awaitUntil("polish callback") { harness.transcripts.isNotEmpty() }
        assertEquals(listOf("polished:帮我看下"), harness.transcripts)
        assertEquals(VoiceInputPhase.Idle, harness.phase)
    }

    @Test fun duplicateFinishedFramesStillAllowStartingAgain() {
        val harness = Harness()
        harness.controller.start()
        harness.ready(0)
        harness.final(0, "帮我看下")
        harness.finished(0)
        harness.finished(0)
        harness.awaitUntil("round 0 to go idle") { harness.phase == VoiceInputPhase.Idle }
        assertEquals(1, harness.transcripts.size)

        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)
        harness.ready(1)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
    }

    @Test fun cancelAfterFinishDropsThePendingPolishedDraft() {
        val harness = Harness(polish = { "polished text" })
        harness.controller.start()
        harness.ready(0)
        harness.final(0, "原始文本")
        harness.finished(0)
        harness.controller.cancel()
        harness.advance(100)
        assertFalse(harness.transcripts.contains("polished text"))
        assertEquals(VoiceInputPhase.Idle, harness.phase)
    }

    /**
     * B1: the socket answers `finished` while stop() is still between its `finish` send and its
     * own state writes. The round is already Idle by then, so stop() must not write Transcribing
     * again, must not add a transcribe timeout, and the transcript may be added at most once.
     */
    @Test fun finishedArrivingInsideStopKeepsIdleAndPolishesAtMostOnce() {
        val harness = Harness(polish = { "polished:$it" }, timeouts = VoiceTimeouts(transcribe = 40))
        harness.controller.start()
        harness.ready(0)
        harness.final(0, "帮我看下")
        harness.sockets[0].onSend = { json ->
            if (json.contains("\"finish\"")) harness.finished(0)
        }

        harness.controller.stop()
        harness.awaitUntil("polish after the concurrent finished") { harness.transcripts.isNotEmpty() }
        assertEquals(VoiceInputPhase.Idle, harness.phase)
        assertEquals(listOf("polished:帮我看下"), harness.transcripts)

        // A stray transcribe timeout would fire by now and repaint the state; it must not exist.
        harness.pollFor(200)
        assertEquals(VoiceInputPhase.Idle, harness.phase)
        assertNull(harness.state.error)
        assertEquals(listOf("polished:帮我看下"), harness.transcripts)

        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)
    }

    /** Same window, but the socket fails during the send and no text was recognised yet. */
    @Test fun failureInsideStopLeavesIdleWithAnError() {
        val harness = Harness(timeouts = VoiceTimeouts(transcribe = 40))
        harness.controller.start()
        harness.ready(0)
        harness.sockets[0].onSend = { json ->
            if (json.contains("\"finish\"")) harness.failureEvent(0)
        }

        harness.controller.stop()
        harness.awaitUntil("failure to surface") { harness.state.error != null }
        assertEquals(VoiceInputPhase.Idle, harness.phase)
        assertTrue(harness.transcripts.isEmpty())

        harness.pollFor(200)
        assertEquals(VoiceInputPhase.Idle, harness.phase)
        assertTrue(harness.transcripts.isEmpty())
    }

    @Test fun connectingWithoutReadyFailsAfterTheConnectionTimeout() {
        val harness = Harness(timeouts = VoiceTimeouts(connect = 60))
        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)

        harness.awaitUntil("connection timeout", timeoutMs = 2_000) {
            harness.phase == VoiceInputPhase.Idle
        }
        assertEquals("连接语音识别服务超时，请重试", harness.state.error)

        // The error is retryable: the next start() is accepted and can become Listening.
        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)
        harness.ready(1)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
    }

    @Test fun readyCancelsTheConnectionTimeout() {
        val harness = Harness(timeouts = VoiceTimeouts(connect = 60))
        harness.controller.start()
        harness.ready(0)
        assertEquals(VoiceInputPhase.Listening, harness.phase)

        // Well past the connection deadline: still listening, no error, no extra transcript.
        harness.pollFor(250)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
        assertNull(harness.state.error)
    }

    @Test fun oldConnectionTimeoutCannotFireIntoARoundStartedAfterCancel() {
        val harness = Harness(timeouts = VoiceTimeouts(connect = 60))
        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)

        harness.controller.cancel()
        harness.controller.start()
        harness.ready(1)
        assertEquals(VoiceInputPhase.Listening, harness.phase)

        // Well past round 0's deadline: only its own (cancelled) timer existed by then.
        harness.pollFor(180)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
        assertNull(harness.state.error)
    }

    @Test fun stopWithADeadSocketStillEndsInIdle() {
        val harness = Harness()
        harness.controller.start()
        harness.ready(0)
        harness.final(0, "帮我看下")
        harness.sockets[0].open = false
        harness.controller.stop()
        harness.awaitUntil("dead-socket stop to settle") { harness.phase == VoiceInputPhase.Idle }
        assertEquals(listOf("帮我看下"), harness.transcripts)
    }

    @Test fun repeatedCancelAndStartAreIdempotent() {
        val harness = Harness()
        harness.controller.start()
        harness.ready(0)
        harness.controller.cancel()
        harness.controller.cancel()
        harness.controller.start()
        harness.controller.cancel()
        assertEquals(VoiceInputPhase.Idle, harness.phase)
        harness.controller.start()
        assertEquals(VoiceInputPhase.Connecting, harness.phase)
        harness.ready(harness.sockets.lastIndex)
        assertEquals(VoiceInputPhase.Listening, harness.phase)
        assertNull(harness.state.error)
    }
}