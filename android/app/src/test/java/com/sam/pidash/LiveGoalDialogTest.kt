package com.sam.pidash

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sam.pidash.domain.model.LiveGoalAnchor
import com.sam.pidash.domain.model.LiveGoalItem
import com.sam.pidash.ui.live.LiveGoalDialog
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
class LiveGoalDialogTest {
    @get:Rule val compose = createComposeRule()

    private fun goal(status: String = "active") = LiveGoalAnchor(
        objective = "完成目标面板操作",
        status = status,
        workItems = listOf(LiveGoalItem("a", "接上暂停", "in_progress")),
    )

    @Test fun activeGoalOffersPauseAndClear() {
        var pauses = 0
        compose.setContent {
            PiDashTheme {
                LiveGoalDialog(
                    goal = goal(),
                    onDismiss = {},
                    onEditWithCommand = {},
                    onPause = { pauses++ },
                    onClear = {},
                )
            }
        }
        compose.onNodeWithText("暂停目标").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, pauses) }
        compose.onNodeWithText("恢复目标").assertDoesNotExist()
    }

    @Test fun pausedGoalOffersResumeInsteadOfPause() {
        var resumes = 0
        compose.setContent {
            PiDashTheme {
                LiveGoalDialog(
                    goal = goal("paused"),
                    onDismiss = {},
                    onEditWithCommand = {},
                    onResume = { resumes++ },
                    onClear = {},
                )
            }
        }
        compose.onNodeWithText("恢复目标").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, resumes) }
        compose.onNodeWithText("暂停目标").assertDoesNotExist()
    }

    @Test fun clearingNeedsTheSecondConfirmation() {
        var clears = 0
        compose.setContent {
            PiDashTheme {
                LiveGoalDialog(
                    goal = goal(),
                    onDismiss = {},
                    onEditWithCommand = {},
                    onClear = { clears++ },
                )
            }
        }
        compose.onNodeWithText("清理目标").performClick()
        compose.onNodeWithText("清理目标？").assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, clears) }
        compose.onNodeWithText("清理").performClick()
        compose.runOnIdle { assertEquals(1, clears) }
    }

    @Test fun completedGoalKeepsClearWithoutPauseOrResume() {
        compose.setContent {
            PiDashTheme {
                LiveGoalDialog(
                    goal = goal("complete"),
                    onDismiss = {},
                    onEditWithCommand = {},
                    onPause = {},
                    onResume = {},
                    onClear = {},
                )
            }
        }
        compose.onNodeWithText("清理目标").assertIsDisplayed()
        compose.onNodeWithText("暂停目标").assertDoesNotExist()
        compose.onNodeWithText("恢复目标").assertDoesNotExist()
    }
}
