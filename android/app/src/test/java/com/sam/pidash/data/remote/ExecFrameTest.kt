package com.sam.pidash.data.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExecFrameTest {
    @Test fun parsesEveryServerFrame() {
        assertEquals(ExecClient.Event.Started, parseExecFrame("""{"type":"started","pid":42}"""))
        assertEquals(ExecClient.Event.Output("hi\n"), parseExecFrame("""{"type":"output","data":"hi\n"}"""))
        assertEquals(ExecClient.Event.Exited(3), parseExecFrame("""{"type":"exit","code":3}"""))
        assertEquals(ExecClient.Event.Failed("idle_timeout", "命令因为长时间没有输入被结束"),
            parseExecFrame("""{"type":"error","code":"idle_timeout","message":"命令因为长时间没有输入被结束"}"""))
    }

    @Test fun unknownOrBrokenFramesAreDroppedInsteadOfRendered() {
        assertNull(parseExecFrame("not json"))
        assertNull(parseExecFrame("[]"))
        assertNull(parseExecFrame("""{"type":"welcome"}"""))
        assertNull(parseExecFrame("""{"type":"output"}"""))
    }

    @Test fun anExitWithoutACodeCountsAsZeroRatherThanCrashing() {
        assertEquals(ExecClient.Event.Exited(0), parseExecFrame("""{"type":"exit"}"""))
    }

    @Test fun errorWithoutFieldsStillProducesAUsableMessage() {
        val event = parseExecFrame("""{"type":"error"}""") as ExecClient.Event.Failed
        assertEquals("error", event.code)
        assertEquals("命令执行失败", event.message)
    }
}
