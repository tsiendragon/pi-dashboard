package com.sam.pidash

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Density
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.ActivityPhase
import com.sam.pidash.domain.model.ActivityStatus
import com.sam.pidash.ui.common.ExpandHint
import com.sam.pidash.ui.live.ActivityStatusPill
import com.sam.pidash.ui.markdown.MarkdownBody
import com.sam.pidash.ui.theme.PiDashTheme
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Golden-image regression for the shared surfaces that carry the app's visual language.
 *
 * Record with `./gradlew :app:recordRoborazziDebug`; verify with `:app:verifyRoborazziDebug`
 * (the plain `test` task runs in verify mode once the PNGs are committed). These cover the
 * pieces a token change touches first — status pill, expand hint, markdown body — without
 * pretending to replace a look at the real device.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-xhdpi")
class ScreenshotTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun statusPills() {
        compose.setContent {
            PiDashTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Column(
                        Modifier.fillMaxWidth().padding(Spacing.lg),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        ActivityStatusPill(ActivityStatus(ActivityPhase.DONE, "已回复"))
                        ActivityStatusPill(ActivityStatus(ActivityPhase.COMMAND, "执行命令", "bash"))
                        ActivityStatusPill(ActivityStatus(ActivityPhase.FAILED, "失败"))
                        ActivityStatusPill(ActivityStatus(ActivityPhase.WAITING, "待确认"))
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/status-pills.png")
    }

    @Test
    fun statusPillsDark() {
        compose.setContent {
            PiDashTheme(darkTheme = true) {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Column(
                        Modifier.fillMaxWidth().padding(Spacing.lg),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        ActivityStatusPill(ActivityStatus(ActivityPhase.DONE, "已回复"))
                        ActivityStatusPill(ActivityStatus(ActivityPhase.COMMAND, "执行命令", "bash"))
                        ActivityStatusPill(ActivityStatus(ActivityPhase.FAILED, "失败"))
                        ActivityStatusPill(ActivityStatus(ActivityPhase.WAITING, "待确认"))
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/status-pills-dark.png")
    }

    @Test
    fun expandHints() {
        compose.setContent {
            PiDashTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Column(
                        Modifier.fillMaxWidth().padding(Spacing.lg),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                    ) {
                        ExpandHint(expanded = false)
                        ExpandHint(expanded = true)
                        ExpandHint(expanded = false, collapsedLabel = "思考", expandedLabel = "收起思考")
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f), Radii.chip)) {
                            Text("执行步骤", Modifier.padding(10.dp), style = PiType.footnote)
                        }
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/expand-hints.png")
    }

    @Test
    fun typeScaleAtTwoHundredPercent() {
        // System font scale 2.0 is the stress case for every fixed-height row in the app.
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) {
                PiDashTheme {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
                            Text("会话 finnote", style = PiType.callout)
                            Text("/home/tsien/apps/pi-dashboard", style = PiType.monoMicro)
                            Text("openai-codex/gpt-6.1-sol · 12 步", style = PiType.caption)
                            Row(
                                Modifier.fillMaxWidth().padding(top = Spacing.sm),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                            ) {
                                ExpandHint(expanded = false)
                                ActivityStatusPill(ActivityStatus(ActivityPhase.WAITING, "待确认"))
                            }
                        }
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/type-scale-large-font.png")
    }

    @Test
    fun markdownBody() {
        compose.setContent {
            PiDashTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
                        MarkdownBody(
                            "# 标题\n\n普通段落带 **加粗**、`行内代码` 和 [链接](https://example.com)。\n\n" +
                                "- 列表一\n- 列表二\n\n```kotlin\nval answer = 42\n// 注释\n```\n",
                            style = PiType.body,
                        )
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/markdown-body.png")
    }
}
