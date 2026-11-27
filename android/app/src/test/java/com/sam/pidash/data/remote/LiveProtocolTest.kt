package com.sam.pidash.data.remote

import com.sam.pidash.domain.model.LiveDetail
import com.sam.pidash.domain.model.LiveSummary
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LiveProtocolTest {
    private fun obj(raw: String) = pidashJson.parseToJsonElement(raw).jsonObject
    private fun detail(vararg entries: String) = LiveDetail(LiveSummary("p", "s", cwd = "/allowed"), entries.map { obj(it) })
    private fun event(sequence: Int, type: String, data: String = "{}", process: String = "p") = obj("""{"type":"event","processInstanceId":"$process","sequence":$sequence,"event":{"type":"$type","data":$data}}""")
    private fun reduce(detail: LiveDetail, sequence: Int, type: String, data: String = "{}") = reduceLiveEvent(detail, event(sequence, type, data))!!

    @Test fun sudoEventsPreserveReasonAndArgumentsUntilClosed() {
        val state = reduce(detail(), 1, "extension_ui", """{"id":"sudo-1","method":"sudo","message":"检查 UID，不修改文件。","command":"[\"/usr/bin/id\",\"-u\"]","host":"fixture","cwd":"/tmp","expiresAt":999999}""")
        assertEquals("sudo", state.pendingUi.single().method)
        assertEquals("检查 UID，不修改文件。", state.pendingUi.single().message)
        assertEquals("[\"/usr/bin/id\",\"-u\"]", state.pendingUi.single().command)
        assertTrue(reduce(state, 2, "extension_ui_closed", """{"id":"sudo-1"}""").pendingUi.isEmpty())
    }

    @Test fun persistedMessagesExposeOnlyRealForkIds() {
        val items = projectLiveTimeline(detail("""{"type":"message","id":"entry-user","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1000}}"""))
        assertEquals("hello", items.single().text)
        assertTrue(items.single().forkable)
        assertEquals("entry-user", items.single().entryId)
        val live = reduce(detail(), 1, "message_end", """{"message":{"role":"user","content":"live"}}""")
        assertFalse(projectLiveTimeline(live).single().forkable)
    }
    @Test fun thinkingAndImagesAreNotLost() {
        val items = projectLiveTimeline(detail(
            """{"type":"message","id":"a","message":{"role":"assistant","content":[{"type":"thinking","thinking":"reasoning"},{"type":"text","text":"answer"}]}}""",
            """{"type":"message","id":"u","message":{"role":"user","content":[{"type":"image","mimeType":"image/png","data":"synthetic"}]}}""",
        ))
        assertEquals("reasoning", items[0].thinking)
        assertEquals("answer", items[0].text)
        // Images are real inline parts now, not placeholder prose.
        assertEquals(1, items[1].images.size)
        assertEquals("", items[1].text)
    }
    @Test fun omittedImagesProjectAsLoadablePlaceholders() {
        val items = projectLiveTimeline(detail(
            """{"type":"message","id":"u","piOmitted":{"images":true},"message":{"role":"user","piOmitted":{"images":true},"content":[{"type":"image","mimeType":"image/png","piImageOmitted":true}]}}""",
        ))
        assertEquals(1, items.single().images.size)
        assertEquals("image/png", items.single().images.single().mimeType)
        assertEquals("", items.single().images.single().data)
        assertTrue(items.single().imagesOmitted)
    }
    @Test fun hiddenThinkingBlocksStayAsThinkingSteps() {
        val items = projectLiveTimeline(detail(
            """{"type":"message","id":"a","message":{"role":"assistant","content":[
                 {"type":"thinking","thinking":"","thinkingSignature":"encrypted"},
                 {"type":"toolCall","id":"t","name":"bash","arguments":{"command":"pwd"}}]}}""",
        ))
        assertEquals(2, items.size)
        assertEquals(listOf(""), items[0].thinkingBlocks)
        assertNull(items[0].thinking)
        assertEquals("bash", items[1].toolName)
    }
    @Test fun streamingReplacesPartialsAndFinal() {
        var state = reduce(detail(), 1, "message_start")
        state = reduce(state, 2, "message_update", """{"message":{"role":"assistant","content":"a"}}""")
        state = reduce(state, 3, "message_update", """{"message":{"role":"assistant","content":"ab"}}""")
        assertEquals(listOf("ab"), projectLiveTimeline(state).map { it.text })
        state = reduce(state, 4, "message_end", """{"message":{"role":"assistant","content":"done"}}""")
        assertEquals(listOf("done"), projectLiveTimeline(state).map { it.text })
    }
    @Test fun entryCarrierEnablesForkWithoutRenderingNoise() {
        var state = reduce(detail(), 1, "message_end", """{"message":{"role":"user","content":"branch"}}""")
        state = reduce(state, 2, "message_entry", """{"entryId":"real-persisted-id"}""")
        assertEquals(1, state.entries.size)
        assertEquals("real-persisted-id", projectLiveTimeline(state).single().entryId)
        assertTrue(projectLiveTimeline(state).single().forkable)
    }
    @Test fun sequenceGapsRequestResyncAndStaleEventsAreIgnored() {
        val state = reduce(detail(), 1, "agent_start")
        assertNull(reduceLiveEvent(state, event(3, "agent_settled")))
        assertEquals(state, reduceLiveEvent(state, event(1, "agent_settled")))
        assertEquals(state, reduceLiveEvent(state, event(2, "agent_settled", process = "another")))
        assertEquals("running", state.summary.status)
        assertEquals("idle", reduce(state, 2, "agent_settled").summary.status)
    }
    @Test fun telemetryAndUiRequestsDoNotBecomeTranscriptRows() {
        var state = reduce(detail(), 1, "summary_update", """{"status":"running","contextUsage":{"tokens":50,"contextWindow":100,"percent":50}}""")
        assertEquals(50L, state.summary.contextUsage?.tokens)
        assertEquals("running", state.summary.status)
        state = reduce(state, 2, "extension_ui", """{"id":"request","method":"confirm","title":"Approve?"}""")
        assertEquals("request", state.pendingUi.single().id)
        state = reduce(state, 3, "extension_ui_closed", """{"id":"request"}""")
        assertTrue(state.pendingUi.isEmpty())
        assertTrue(projectLiveTimeline(state).isEmpty())
    }
    @Test fun modelNameAndEffortChangesProject() {
        var state = reduce(detail(), 1, "model_select", """{"model":{"provider":"p","id":"m"}}""")
        state = reduce(state, 2, "thinking_level_select", """{"level":"high"}""")
        state = reduce(state, 3, "session_info_changed", """{"name":"New name"}""")
        assertEquals("m", state.summary.model?.id)
        assertEquals("high", state.summary.thinkingLevel)
        assertEquals("New name", state.summary.title)
    }
    @Test fun compactSyncCarriesRedactionMarkersWithoutLeakingSecretProse() {
        val detail = LiveDetail(
            LiveSummary("p", "s", cwd = "/allowed"),
            listOf(
                obj("""{"type":"message","id":"m1","piOmitted":{"thinking":true,"args":true},"message":{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"toolCall","id":"c1","name":"bash","piArgsOmitted":true},{"type":"text","text":"final"}]}}"""),
                obj("""{"type":"message","id":"r1","piOmitted":{"output":true},"message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[]}}"""),
                obj("""{"type":"tool_execution_end","piOmitted":{"args":true,"output":true},"data":{"toolCallId":"c1","toolName":"bash","isError":false}}"""),
            ),
        )
        val items = projectLiveTimeline(detail)
        val message = items.first { it.id == "m1" }
        assertTrue(message.thinkingOmitted)
        assertTrue(message.toolArgsOmitted)
        assertEquals("final", message.text)
        assertTrue(items.any { it.toolCallId == "c1" && it.toolOutputOmitted })
        assertTrue(items.any { it.toolCallId == "c1" && it.toolArgsOmitted })
    }

    @Test fun summaryKeepsTheServerScrubbedGitRemote() {
        val summary = pidashJson.decodeFromString<LiveSummary>(
            """{"processInstanceId":"p","sessionId":"s","cwd":"/work","canonicalCwd":"/work","git":{"root":"/work","branch":"main","remoteUrl":"https://github.com/acme/app.git"}}"""
        )
        assertEquals("https://github.com/acme/app.git", summary.git?.remoteUrl)
        assertEquals("main", summary.git?.branch)
    }

    @Test fun toolProgressUsesOneStableCardAndRetainsArguments() {
        var state = reduce(detail(), 1, "tool_execution_start", """{"toolCallId":"t1","toolName":"read","args":{"path":"fixture"}}""")
        state = reduce(state, 2, "tool_execution_update", """{"toolCallId":"t1","toolName":"read","partialResult":{"content":[{"type":"text","text":"partial"}]}}""")
        assertEquals(1, projectLiveTimeline(state).size)
        // Arguments stay on the step line (`toolArgs`) instead of the output text.
        assertTrue(projectLiveTimeline(state).single().toolArgs.orEmpty().contains("fixture"))
        assertTrue(projectLiveTimeline(state).single().text.contains("partial"))
        state = reduce(state, 3, "tool_execution_end", """{"toolCallId":"t1","toolName":"read","result":{"content":[{"type":"text","text":"failed"}]},"isError":true}""")
        assertEquals(1, projectLiveTimeline(state).size)
        assertEquals("failed", projectLiveTimeline(state).single().text)
        assertTrue(projectLiveTimeline(state).single().isError)
    }
    @Test fun identicalLegitimateUserMessagesArePreserved() {
        var state = reduce(detail(), 1, "message_end", """{"message":{"role":"user","content":"retry"}}""")
        state = reduce(state, 2, "message_end", """{"message":{"role":"user","content":"retry"}}""")
        assertEquals(2, projectLiveTimeline(state).size)
    }
    @Test fun snapshotAndSameFinalAreDeduplicatedByMessageIdentity() {
        val initial = detail("""{"type":"message","id":"entry","message":{"role":"assistant","content":"done","timestamp":1234}}""")
        val state = reduce(initial, 1, "message_end", """{"message":{"role":"assistant","content":"done","timestamp":1234}}""")
        assertEquals(1, projectLiveTimeline(state).size)
    }
    @Test fun distinctPersistedEntriesWithSameTimestampAreNotMerged() {
        val initial = detail("""{"type":"message","id":"first","message":{"role":"user","content":"same","timestamp":1234}}""")
        val state = reduce(initial, 1, "message_end", """{"entryId":"second","message":{"role":"user","content":"same","timestamp":1234}}""")
        assertEquals(2, projectLiveTimeline(state).size)
    }
    @Test fun malformedFramesAndRowsAreSafe() {
        assertEquals(detail(), reduceLiveEvent(detail(), obj("""{"processInstanceId":"p","type":"event","sequence":{}}""")))
        val items = projectLiveTimeline(detail("{}", """{"type":"message","message":{"role":{}}}""", """{"type":"message_end","data":null}"""))
        assertTrue(items.isEmpty())
    }
    @Test fun emptyProviderAndToolFailuresRemainVisible() {
        val items = projectLiveTimeline(detail(
            """{"type":"message","id":"a","message":{"role":"assistant","content":[],"stopReason":"error"}}""",
            """{"type":"message","id":"t","message":{"role":"toolResult","toolName":"read","content":[],"isError":true}}""",
        ))
        assertEquals(2, items.size)
        assertTrue(items.all { it.isError && it.text.isNotBlank() })
    }
    @Test fun persistedToolResultReplacesExecutionPreviewWithoutDuplicateCards() {
        val items = projectLiveTimeline(detail(
            """{"type":"tool_execution_end","data":{"toolCallId":"t","toolName":"read","result":{"content":[{"type":"text","text":"output"}]}}}""",
            """{"type":"message","id":"entry","message":{"role":"toolResult","toolCallId":"t","toolName":"read","content":[{"type":"text","text":"output"}]}}""",
        ))
        assertEquals(1, items.size)
        assertEquals("output", items.single().text)
    }
    @Test fun eventStorageIsBounded() {
        var state = detail()
        for (i in 1..1005) state = reduce(state, i, "message_end", """{"message":{"role":"user","content":"$i"}}""")
        assertEquals(1000, state.entries.size)
        assertEquals(1000, projectLiveTimeline(state).size)
    }
}
