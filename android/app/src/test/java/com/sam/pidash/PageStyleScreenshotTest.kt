package com.sam.pidash

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.common.SegmentedTabs
import com.sam.pidash.ui.theme.PiDashTheme
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import androidx.test.ext.junit.runners.AndroidJUnit4

/** Shared production theme/cards/controls, not a claim of whole-page or real-device coverage. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-xhdpi")
class PageStyleScreenshotTest {
    @get:Rule val compose = createComposeRule()

    @Test fun light() = capture("page-style-light")
    @Test fun dark() = capture("page-style-dark", dark = true)
    @Test fun largeFont() = capture("page-style-large-font", scale = 2f)
    @Test @Config(qualifiers = "w600dp-h800dp-xhdpi")
    fun wide() = capture("page-style-wide")

    @OptIn(ExperimentalLayoutApi::class)
    private fun capture(name: String, dark: Boolean = false, scale: Float = 1f) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = scale)) {
                PiDashTheme(darkTheme = dark) {
                    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.padding(Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            Text("主会话", style = PiType.pageTitle)
                            Text("机器列表 / 设置", style = MaterialTheme.typography.titleLarge)
                            ProvideTextStyle(MaterialTheme.typography.headlineSmall) { Text("新建 Live Pi") }
                            GroupedCard {
                                Column(Modifier.padding(Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                                    Text("统一的卡片标题", style = PiType.rowTitle)
                                    Text("与主会话一致的正文", style = PiType.body)
                                    Text("辅助说明 · 3 个项目", style = PiType.footnote, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Text("/srv/pi-dashboard", style = PiType.monoMicro, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            PiTextField(value = "关键词", onValueChange = {}, modifier = Modifier.fillMaxWidth(),
                                label = "搜索项目")
                            SegmentedTabs(listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色"),
                                selected = "system", onSelect = {})
                            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                                TextButton(onClick = {}) { Text("取消") }
                                TextButton(onClick = {}) { Text("继续") }
                            }
                        }
                    }
                }
            }
        }
        compose.onNodeWithText("取消").assertIsDisplayed()
        compose.onNodeWithText("继续").assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/$name.png")
    }
}
