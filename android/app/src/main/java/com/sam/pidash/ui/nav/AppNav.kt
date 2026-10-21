package com.sam.pidash.ui.nav

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.sam.pidash.data.repo.PiDashRepository
import com.sam.pidash.domain.model.SessionKey
import com.sam.pidash.ui.backends.BackendsScreen
import com.sam.pidash.ui.chat.ChatScreen
import com.sam.pidash.ui.live.LiveSessionScreen
import com.sam.pidash.ui.sessions.SessionsScreen

object Routes {
    const val SESSIONS = "sessions"
    const val BACKENDS = "backends"
    const val CHAT = "chat/{backendId}/{slotKey}"
    const val LIVE = "live/{backendId}/{processId}"

    fun live(key: SessionKey): String =
        "live/${Uri.encode(key.backendId)}/${Uri.encode(key.slotKey)}"

    fun chat(key: SessionKey): String =
        "chat/${Uri.encode(key.backendId)}/${Uri.encode(key.slotKey)}"
}

@Composable
fun AppNav(repo: PiDashRepository) {
    val nav = rememberNavController()

    NavHost(navController = nav, startDestination = Routes.SESSIONS) {
        composable(Routes.SESSIONS) {
            SessionsScreen(
                repo = repo,
                onOpenSlot = { key -> nav.navigate(Routes.chat(key)) },
                onOpenLive = { key -> nav.navigate(Routes.live(key)) },
                onOpenBackends = { nav.navigate(Routes.BACKENDS) },
            )
        }

        composable(Routes.BACKENDS) {
            BackendsScreen(repo = repo, onBack = { nav.popBackStack() })
        }

        composable(
            route = Routes.LIVE,
            arguments = listOf(
                navArgument("backendId") { type = NavType.StringType },
                navArgument("processId") { type = NavType.StringType },
            ),
        ) { entry ->
            LiveSessionScreen(
                repo = repo,
                sessionKey = SessionKey(
                    entry.arguments?.getString("backendId").orEmpty(),
                    entry.arguments?.getString("processId").orEmpty(),
                ),
                onBack = { nav.popBackStack() },
                onOpenLive = { key ->
                    nav.navigate(Routes.live(key)) {
                        popUpTo(Routes.SESSIONS)
                        launchSingleTop = true
                    }
                },
            )
        }

        composable(
            route = Routes.CHAT,
            arguments = listOf(
                navArgument("backendId") { type = NavType.StringType },
                navArgument("slotKey") { type = NavType.StringType },
            ),
        ) { entry ->
            val backendId = entry.arguments?.getString("backendId").orEmpty()
            val slotKey = entry.arguments?.getString("slotKey").orEmpty()
            ChatScreen(
                repo = repo,
                sessionKey = SessionKey(backendId, slotKey),
                onBack = { nav.popBackStack() },
            )
        }
    }
}
