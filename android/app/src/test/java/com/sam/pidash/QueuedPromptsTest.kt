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
import com.sam.pidash.domain.model.LiveQueueItem
import com.sam.pidash.ui.live.QueuedPromptsBar
import com.sam.pidash.ui.live.QueuedPromptsSheet
import com.sam.pidash.ui.theme.PiDashTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-xhdpi")
class QueuedPromptsTest {
    @get:Rule val compose = createComposeRule()

    private val first = LiveQueueItem(id = "q1", text = "顺便跑一下 lint\n并修掉问题", channel = "mobile", deliverAs = "steer")
    private val second = LiveQueueItem(id = "q2", text = "然后把 README 更新一下", channel = "web", imageCount = 1)

    @Test fun theBarSummarisesWithoutOpeningTheSheet() {
        var opened = 0
        compose.setContent {
            PiDashTheme { Surface { QueuedPromptsBar(listOf(first, second), onOpen = { opened++ }) } }
        }
        compose.onNodeWithText("排队 2 条").assertIsDisplayed()
        compose.onNodeWithText("顺便跑一下 lint 并修掉问题").assertIsDisplayed()
        compose.onNodeWithText("查看").performClick()
        assertEquals(1, opened)
    }

    @Test fun nothingIsDrawnWhenTheQueueIsEmpty() {
        compose.setContent { PiDashTheme { Surface { QueuedPromptsBar(emptyList(), onOpen = {}) } } }
        compose.onNodeWithText("查看").assertDoesNotExist()
    }

    @Test fun theSheetListsEachQueuedPromptWithItsOwnWithdrawal() {
        val cancelled = mutableListOf<String>()
        compose.setContent {
            PiDashTheme {
                Surface {
                    QueuedPromptsSheet(
                        items = listOf(first, second), active = null, busy = false, error = null,
                        onCancel = { cancelled += it.id }, onDismiss = {},
                    )
                }
            }
        }
        compose.onNodeWithText("排队的消息").assertIsDisplayed()
        compose.onNodeWithText("引导 · mobile").assertIsDisplayed()
        compose.onNodeWithText("排队 · 1 张图片 · web").assertIsDisplayed()
        compose.onAllNodesWithText("撤回").assertCountEquals(2)
        compose.onAllNodesWithText("撤回")[1].performClick()
        assertEquals(listOf("q2"), cancelled)
    }

    @Test fun anAlreadyDispatchedPromptIsShownButNotWithdrawn() {
        compose.setContent {
            PiDashTheme {
                Surface {
                    QueuedPromptsSheet(
                        items = listOf(second), active = first, busy = false, error = null,
                        onCancel = {}, onDismiss = {},
                    )
                }
            }
        }
        compose.onNodeWithText("正在发送：顺便跑一下 lint 并修掉问题").assertIsDisplayed()
        compose.onAllNodesWithText("撤回").assertCountEquals(1)
    }

    @Test fun aFailureIsReportedNextToTheRows() {
        compose.setContent {
            PiDashTheme {
                Surface {
                    QueuedPromptsSheet(
                        items = listOf(second), active = null, busy = false,
                        error = "撤回失败；这条可能已经开始执行。", onCancel = {}, onDismiss = {},
                    )
                }
            }
        }
        compose.onNodeWithText("撤回失败；这条可能已经开始执行。").assertIsDisplayed()
    }

    @Test fun withdrawIsDisabledWhileAnotherWithdrawalIsInFlight() {
        compose.setContent {
            PiDashTheme {
                Surface {
                    QueuedPromptsSheet(
                        items = listOf(second), active = null, busy = true, error = null,
                        onCancel = {}, onDismiss = {},
                    )
                }
            }
        }
        compose.onNodeWithText("撤回").assertIsNotEnabled()
        compose.onNodeWithText("撤回").assertHeightIsAtLeast(48.dp)
    }

    @Test fun theBarKeepsItsTouchHeightAtLargeFonts() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                PiDashTheme { Surface { QueuedPromptsBar(listOf(first), onOpen = {}) } }
            }
        }
        compose.onNodeWithText("查看").assertHeightIsAtLeast(48.dp)
    }

    @Test fun barShots() {
        compose.setContent {
            PiDashTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                        QueuedPromptsBar(listOf(first, second), onOpen = {})
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/queued-prompts.png")
    }

    @Test fun darkBarShot() {
        compose.setContent {
            PiDashTheme(darkTheme = true) {
                Surface(color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                        QueuedPromptsBar(listOf(first), onOpen = {})
                    }
                }
            }
        }
        compose.onRoot().captureRoboImage("src/test/screenshots/queued-prompts-dark.png")
    }
}