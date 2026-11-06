package com.sam.pidash.ui.live

import com.sam.pidash.domain.model.LiveUiRequest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class SudoCommandReviewTest {
    private fun request() = LiveUiRequest(id = "sudo-test", method = "sudo", message = "查看 nginx 服务状态，确认是否正常运行。", command = "[\"/usr/bin/systemctl\",\"status\",\"nginx\"]", host = "fixture-host", cwd = "/srv/app", expiresAt = 2000)

    @Test fun commandIsReadableWithoutLosingOriginalArguments() {
        val result = sudoCommandReview(request().command)!!
        assertEquals("sudo -A -k -- /usr/bin/systemctl status nginx", result.preview)
        assertEquals(JsonArray(listOf("/usr/bin/systemctl", "status", "nginx").map(::JsonPrimitive)),
            kotlinx.serialization.json.Json.parseToJsonElement(result.rawArguments))
    }
    @Test fun quoteBoundariesAndEmptyArgumentsRemainVisible() {
        val argv = listOf("/path with space/tool", "two words", "", "$(touch /tmp/not-run)", "it's")
        val result = sudoCommandReview(JsonArray(argv.map(::JsonPrimitive)).toString())!!
        assertTrue(result.preview.contains("'/path with space/tool'"))
        assertTrue(result.preview.contains("'two words' '' '$(touch /tmp/not-run)'"))
        assertTrue(result.preview.endsWith("'it'\\''s'"))
        assertEquals(JsonArray(argv.map(::JsonPrimitive)), kotlinx.serialization.json.Json.parseToJsonElement(result.rawArguments))
    }
    @Test fun controlAndBidiCharactersAreNotRenderedInvisibly() {
        val result = sudoCommandReview(JsonArray(listOf("/usr/bin/printf", "a\nb\t\u202ec").map(::JsonPrimitive)).toString())!!
        assertFalse(result.preview.contains('\n'))
        assertFalse(result.preview.contains('\u202e'))
        assertTrue(result.preview.contains("\\n"))
        assertTrue(result.preview.contains("\\u202e"))
    }
    @Test fun invalidCommandShapesCannotBeApproved() {
        for (command in listOf(null, "hello", "[]", "[1]", "[\"relative\"]", "[\"/bin/echo\",null]", "[\"/bin/echo\",\"\\u0000\"]")) {
            assertNull(sudoCommandReview(command))
            assertFalse(sudoReviewReady(request().copy(command = command), 1000))
        }
    }
    @Test fun explanationAndCompleteTargetAreRequiredBeforeApproval() {
        val request = request()
        assertTrue(sudoReviewReady(request, 1000))
        assertFalse(sudoReviewReady(request.copy(message = null), 1000))
        assertFalse(sudoReviewReady(request.copy(message = "  "), 1000))
        assertFalse(sudoReviewReady(request.copy(message = "x".repeat(801)), 1000))
        assertFalse(sudoReviewReady(request.copy(host = ""), 1000))
        assertFalse(sudoReviewReady(request.copy(cwd = ""), 1000))
        assertFalse(sudoReviewReady(request, 2000))
    }
}
