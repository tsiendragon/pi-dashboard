package com.sam.pidash

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.common.appVersionText
import com.sam.pidash.ui.common.CompactHeaderAction
import com.sam.pidash.ui.common.CompactPageHeader
import com.sam.pidash.ui.common.GroupedCard
import com.sam.pidash.ui.common.PrimaryCreateAction
import com.sam.pidash.ui.live.LiveConnectionStrip
import com.sam.pidash.ui.live.SessionListControls
import com.sam.pidash.ui.live.SessionModeTabs
import com.sam.pidash.ui.theme.PiDashTheme
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Spacing
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Actual shared header/connection/filter controls with synthetic list data; no backend or credentials. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h720dp-xhdpi")
class SessionChromeTest {
    @get:Rule val compose = createComposeRule()

    @Test fun compactLight() { fixture(); capture("session-chrome-light") }
    @Test fun compactDark() {
        fixture(dark = true)
        compose.onNodeWithText("工作中").performClick()
        capture("session-chrome-dark")
    }
    @Test fun compactLargeFont() { fixture(scale = 2f); capture("session-chrome-large-font") }
    @Test @Config(qualifiers = "w600dp-h800dp-xhdpi")
    fun compactWide() { fixture(); capture("session-chrome-wide") }

    @Test fun headerActionsAndSinglePrimaryAction() {
        var creates = 0
        var refreshes = 0
        var infos = 0
        fixture(onCreate = { creates++ }, onRefresh = { refreshes++ }, onInfo = { infos++ })
        compose.onAllNodesWithContentDescription("新建会话").assertCountEquals(1)
        compose.onNodeWithContentDescription("新建会话").performClick()
        compose.onNodeWithContentDescription("刷新").performClick()
        compose.onNodeWithContentDescription("连接与只读说明").performClick()
        assertEquals(1, creates)
        assertEquals(1, refreshes)
        assertEquals(1, infos)
        compose.onNodeWithText(appVersionText()).assertDoesNotExist()
    }

    @Test fun filteringAndSortingKeepTheirMutualExclusion() {
        fixture()
        compose.onNodeWithContentDescription("搜索会话").performTextInput("dashboard")
        compose.onNodeWithText("排序").assertIsNotEnabled()
        compose.onNodeWithContentDescription("清除搜索").performClick()
        compose.onNodeWithText("工作中").performClick().assertIsSelected()
        compose.onNodeWithText("排序").assertIsNotEnabled()
        compose.onNodeWithText("工作中").performClick()
        compose.onNodeWithText("排序").performClick()
        compose.onNodeWithContentDescription("搜索会话").assertIsNotEnabled()
        compose.onNodeWithText("分组").assertIsNotEnabled()
        compose.onNodeWithText("完成排序").performClick()
        compose.onNodeWithContentDescription("搜索会话").assertIsEnabled()
    }

    @Test fun compactActionsKeepTouchTargets() {
        fixture()
        listOf("返回机器列表", "刷新", "服务器", "连接与只读说明").forEach {
            compose.onNodeWithContentDescription(it).assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
        }
        compose.onNodeWithText("工作中").assertTouchHeightIsEqualTo(48.dp)
        compose.onNodeWithText("分组").assertTouchHeightIsEqualTo(48.dp)
    }

    private fun capture(name: String) {
        compose.onNodeWithText("home").assertIsDisplayed()
        compose.onRoot().captureRoboImage("src/test/screenshots/$name.png")
    }

    private fun fixture(dark: Boolean = false, scale: Float = 1f, onCreate: () -> Unit = {},
        onRefresh: () -> Unit = {}, onInfo: () -> Unit = {}) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = scale)) {
                PiDashTheme(darkTheme = dark) {
                    var query by remember { mutableStateOf("") }
                    var running by remember { mutableStateOf(false) }
                    var children by remember { mutableStateOf(false) }
                    var sorting by remember { mutableStateOf(false) }
                    var liveTab by remember { mutableStateOf(true) }
                    Scaffold(topBar = {
                        CompactPageHeader("home", navigationIcon = {
                            CompactHeaderAction(Icons.AutoMirrored.Filled.ArrowBack, "返回机器列表") {}
                        }) {
                            CompactHeaderAction(Icons.Filled.Refresh, "刷新", onRefresh)
                            CompactHeaderAction(Icons.Filled.Settings, "服务器") {}
                        }
                    }, floatingActionButton = { PrimaryCreateAction("新建会话", onCreate) }) { padding ->
                        Column(Modifier.fillMaxSize().padding(padding)) {
                            SessionModeTabs(liveTab) { liveTab = it }
                            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 96.dp)) {
                                item { LiveConnectionStrip("Live Pi：已连接", true, false, null, onInfo, {}) }
                                item {
                                    Column(Modifier.padding(horizontal = Spacing.md)) {
                                        SessionListControls(query, { query = it }, running, { running = !running },
                                            children, { children = !children }, sorting, { sorting = !sorting },
                                            canGroup = !sorting, canSort = sorting || (query.isBlank() && !running), onGroups = {})
                                    }
                                }
                                item { Text("未分组  3", style = PiType.caption, modifier = Modifier.padding(Spacing.md)) }
                                item {
                                    Box(Modifier.padding(horizontal = Spacing.md)) {
                                        GroupedCard {
                                            listOf("finnote", "pi-dashboard", "pi-matrix").forEach { name ->
                                                Column(Modifier.fillMaxWidth().padding(Spacing.md)) {
                                                    Text(name, style = PiType.rowTitle)
                                                    Text("/srv/projects/$name", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                    Text("provider/model", style = PiType.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
