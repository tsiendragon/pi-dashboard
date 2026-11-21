package com.sam.pidash

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.domain.model.MachineDiskLoad
import com.sam.pidash.domain.model.MachineGpuLoad
import com.sam.pidash.domain.model.MachineLoad
import com.sam.pidash.domain.model.MachineLoadState
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.sessions.MachineLoadSummary
import com.sam.pidash.ui.theme.PiDashTheme
import com.sam.pidash.ui.theme.Spacing
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Machine-card metrics: CPU/memory always, GPU/disk only when the server reports them. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class MachineLoadSummaryTest {
    @get:Rule val compose = createComposeRule()

    private fun load(
        cpu: Double = 42.0,
        memory: Double = 63.0,
        gpu: MachineGpuLoad? = MachineGpuLoad(
            count = 1,
            name = "AMD GPU",
            utilizationPercent = 37.5,
            memoryUsedBytes = 2_147_483_648,
            memoryTotalBytes = 8_589_934_592,
            memoryUsedPercent = 25.0,
        ),
        disk: MachineDiskLoad? = MachineDiskLoad(
            totalBytes = 536_870_912_000,
            usedBytes = 268_435_456_000,
            availableBytes = 268_435_456_000,
            usedPercent = 50.0,
        ),
    ) = MachineLoadState(
        load = MachineLoad(
            cpuCount = 16,
            cpuPercent = cpu,
            load1 = 3.2,
            load5 = 2.1,
            load15 = 1.4,
            memoryTotalBytes = 34_359_738_368,
            memoryUsedBytes = 21_646_635_172,
            memoryAvailableBytes = 12_713_103_196,
            memoryUsedPercent = memory,
            gpu = gpu,
            disk = disk,
            sampledAt = 1,
        ),
    )

    private fun render(state: MachineLoadState, dark: Boolean = false, scale: Float = 1f) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale)) {
                PiDashTheme(darkTheme = dark) {
                    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.width(360.dp).padding(Spacing.md)) {
                            GroupedCard {
                                Column(Modifier.padding(Spacing.md)) { MachineLoadSummary(state) }
                            }
                        }
                    }
                }
            }
        }
    }

    @Test fun fullMetricsAndScreenshot() {
        render(load())
        compose.onNodeWithText("CPU").assertIsDisplayed()
        compose.onNodeWithText("内存").assertIsDisplayed()
        compose.onNodeWithText("GPU").assertIsDisplayed()
        compose.onNodeWithText("磁盘").assertIsDisplayed()
        compose.onNodeWithText("显存 2.0 / 8.0", substring = true).assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/machine-load-full.png")
    }

    @Test fun fullMetricsDarkScreenshot() {
        render(load(), dark = true)
        compose.onRoot().captureRoboImage("src/test/screenshots/machine-load-full-dark.png")
    }

    @Test fun largeFontKeepsMetricsReadable() {
        render(load(), scale = 2f)
        compose.onNodeWithText("GPU").assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/machine-load-large-font.png")
    }

    @Test fun oldBackendWithoutGpuOrDiskDoesNotFabricateRows() {
        render(load(gpu = null, disk = null))
        compose.onNodeWithText("GPU").assertDoesNotExist()
        compose.onNodeWithText("磁盘").assertDoesNotExist()
    }

    @Test fun hotDiskWinsTheSingleWarningLine() {
        render(load(cpu = 95.0, memory = 92.0, disk = MachineDiskLoad(100, 96, 4, 96.0)))
        compose.onNodeWithText("磁盘空间接近上限", substring = true).assertIsDisplayed()
    }
}
