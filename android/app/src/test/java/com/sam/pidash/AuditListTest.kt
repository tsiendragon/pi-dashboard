package com.sam.pidash

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.LiveAuditEntry
import com.sam.pidash.ui.live.LiveAuditList
import com.sam.pidash.ui.live.auditActionLabel
import com.sam.pidash.ui.live.auditMethodLabel
import com.sam.pidash.ui.theme.PiDashTheme
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class AuditListTest {
    @get:Rule val compose = createComposeRule()

    private val allowed = LiveAuditEntry(
        at = 1_716_196_200_000, processInstanceId = "p", action = "allowed", method = "confirm",
        title = "允许运行：rm -rf build", client = "browser-",
    )
    private val withdrawn = LiveAuditEntry(
        at = 1_716_195_600_000, processInstanceId = "p", action = "withdrawn", method = "queue", detail = "剩余 1 条",
    )
    private val denied = LiveAuditEntry(
        at = 1_716_195_000_000, processInstanceId = "p", action = "denied", method = "confirm", title = "删除构建目录",
    )

    private fun fixture(entries: List<LiveAuditEntry>?, loading: Boolean = false, error: String? = null, dark: Boolean = false, scale: Float = 1f, shot: String? = null) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale)) {
                PiDashTheme(darkTheme = dark) {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            LiveAuditList(entries, loading, error)
                        }
                    }
                }
            }
        }
        shot?.let { compose.onRoot().captureRoboImage("src/test/screenshots/$it.png") }
    }

    @Test fun eachDecisionReadsAsItsOutcome() {
        assertEquals("已允许", auditActionLabel("allowed"))
        assertEquals("已拒绝", auditActionLabel("denied"))
        assertEquals("已授权", auditActionLabel("authorized"))
        assertEquals("已撤回排队", auditActionLabel("withdrawn"))
        assertEquals("已记录", auditActionLabel("something-new"))
        assertEquals("排队消息", auditMethodLabel("queue"))
        assertNull(auditMethodLabel(null))
        assertNull(auditMethodLabel("unknown"))
    }

    @Test fun rowsShowOutcomeMethodTimeSourceAndTitle() {
        fixture(listOf(allowed, withdrawn, denied))
        compose.onNodeWithText("已允许").assertIsDisplayed()
        compose.onAllNodesWithText("确认").assertCountEquals(2)
        compose.onNodeWithText("允许运行：rm -rf build").assertIsDisplayed()
        compose.onNodeWithText("来源 browser-").assertIsDisplayed()
        compose.onNodeWithText("已撤回排队").assertIsDisplayed()
        compose.onNodeWithText("剩余 1 条").assertIsDisplayed()
        // No password / argv promise is stated next to the data, not buried in docs.
        compose.onNodeWithText("记录由 Dashboard 本地保存：时间、决定与来源端；不会保存密码或 sudo 完整参数。").assertIsDisplayed()
    }

    @Test fun emptyAndFailedLoadsAreDifferentStates() {
        fixture(emptyList())
        compose.onNodeWithText("这一会话还没有需要处理的请求或撤回。").assertIsDisplayed()
    }

    @Test fun aFailedLoadSaysSoInsteadOfLookingEmpty() {
        fixture(entries = null, error = "HTTP 500")
        compose.onNodeWithText("读取记录失败：HTTP 500").assertIsDisplayed()
        compose.onNodeWithText("这一会话还没有需要处理的请求或撤回。").assertDoesNotExist()
    }

    @Test fun loadingShowsProgress() {
        fixture(entries = null, loading = true)
        compose.onNodeWithText("读取记录失败", substring = true).assertDoesNotExist()
    }

    @Test fun rendersAtTwoHundredPercent() {
        fixture(listOf(allowed, withdrawn), scale = 2f, shot = "audit-log-large-font")
        compose.onNodeWithText("已允许").assertIsDisplayed()
    }

    @Test fun lightShot() {
        fixture(listOf(allowed, withdrawn, denied), shot = "audit-log")
        compose.onNodeWithText("已拒绝").assertIsDisplayed()
    }

    @Test fun darkShot() {
        fixture(listOf(allowed, withdrawn, denied), dark = true, shot = "audit-log-dark")
        compose.onNodeWithText("已允许").assertIsDisplayed()
    }

    @Test fun parsesTheServerShape() {
        val json = Json { ignoreUnknownKeys = true }
        val entry = json.decodeFromString(LiveAuditEntry.serializer(), """{"at":1716196200000,"processInstanceId":"p","action":"authorized","method":"sudo","title":"管理员授权","client":"browser-","extra":1}""")
        assertEquals("authorized", entry.action)
        assertEquals("sudo", entry.method)
        assertEquals("browser-", entry.client)
    }
}