package com.sam.pidash.data.voice

import com.sam.pidash.domain.model.appendVoiceTranscript
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

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
}