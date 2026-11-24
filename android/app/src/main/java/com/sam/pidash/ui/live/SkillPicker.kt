package com.sam.pidash.ui.live

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sam.pidash.data.repo.LivePiRepository
import com.sam.pidash.domain.model.LiveSkill
import com.sam.pidash.ui.common.PiTextField
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.Radii
import com.sam.pidash.ui.theme.Spacing
import com.sam.pidash.ui.theme.Tints

internal fun filterSkills(skills: List<LiveSkill>, query: String): List<LiveSkill> {
    val needle = query.trim()
    return skills
        .filter {
            needle.isBlank() || it.name.contains(needle, ignoreCase = true) ||
                it.description.contains(needle, ignoreCase = true)
        }
        .distinctBy { it.name.lowercase() }
        .sortedBy { it.name.lowercase() }
}

/**
 * Put the skill invocation first so existing prose becomes the skill's arguments;
 * this is the documented `/skill:name <args>` form. Refuse names that could inject
 * a second line or break the command token.
 */
internal fun insertSkillDraft(draft: String, name: String): String? {
    val skill = name.trim()
    if (!skill.matches(Regex("""^[\p{L}\p{N}][\p{L}\p{N}._-]*$"""))) return null
    val command = "/skill:$skill "
    val rest = draft.trimStart()
    return if (rest.isBlank()) command else command + rest
}

/**
 * Searchable skill picker. The skill list is read-only Dashboard metadata; choosing
 * only edits the local draft, so it never needs a lease or sends a command by itself.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LiveSkillPickerSheet(
    repo: LivePiRepository,
    backendId: String,
    cwd: String?,
    draft: String,
    onDismiss: () -> Unit,
    onApply: (String) -> Unit,
) {
    var skills by remember(backendId, cwd) { mutableStateOf<List<LiveSkill>?>(null) }
    var loading by remember(backendId, cwd) { mutableStateOf(true) }
    var error by remember(backendId, cwd) { mutableStateOf<String?>(null) }
    var revision by remember(backendId, cwd) { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }

    LaunchedEffect(backendId, cwd, revision) {
        loading = true
        error = null
        repo.skills(backendId, cwd).fold(
            onSuccess = { skills = it },
            onFailure = { error = it.message ?: "无法读取技能列表" },
        )
        loading = false
    }

    ModalBottomSheet(onDismissRequest = onDismiss, shape = Radii.sheet) {
        Column(Modifier.fillMaxWidth().heightIn(max = 620.dp).padding(bottom = Spacing.lg)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("选择技能", style = PiType.pageTitle)
                    Text(
                        "按名称或描述筛选；选择后插入 /skill:<name>，已有草稿会保留在命令后面。",
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = { revision++ }, enabled = !loading) { Text("刷新") }
            }
            PiTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm),
                placeholder = "筛选技能名或描述",
                singleLine = true,
            )
            val all = skills.orEmpty()
            val visible = remember(all, query) { filterSkills(all, query) }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let {
                Column(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm)) {
                    Text("读取技能失败：$it", style = PiType.footnote, color = MaterialTheme.colorScheme.error)
                    TextButton(enabled = !loading, onClick = { revision++ }) { Text("重试") }
                }
            }
            when {
                loading && skills == null -> Unit
                skills != null && all.isEmpty() -> Text(
                    "服务器没有找到可用技能。可在 Dashboard 技能目录添加后刷新。",
                    modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.md),
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                skills != null && visible.isEmpty() -> Text(
                    "没有匹配「$query」的技能。",
                    modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.md),
                    style = PiType.footnote,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                ) {
                    if (skills != null) Text(
                        "${visible.size}/${all.size} 个技能",
                        modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
                        style = PiType.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    visible.forEachIndexed { index, skill ->
                        if (index > 0) HorizontalDivider(
                            modifier = Modifier.padding(horizontal = Spacing.lg),
                            color = MaterialTheme.colorScheme.outline.copy(alpha = Tints.Hairline),
                        )
                        Row(
                            Modifier.fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clickable { onApply(skill.name) }
                                .padding(horizontal = Spacing.lg, vertical = Spacing.sm),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Spacing.md),
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    skill.name,
                                    style = PiType.rowTitle.copy(fontWeight = FontWeight.SemiBold),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                if (skill.description.isNotBlank()) Text(
                                    skill.description,
                                    style = PiType.caption,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
            if (draft.isNotBlank()) Text(
                "选择后会生成：/skill:<name> ${draft.trim().take(80)}",
                modifier = Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.xs),
                style = PiType.caption,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
