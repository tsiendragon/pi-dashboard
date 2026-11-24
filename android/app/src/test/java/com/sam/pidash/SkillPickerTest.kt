package com.sam.pidash

import com.sam.pidash.domain.model.LiveSkill
import com.sam.pidash.ui.live.filterSkills
import com.sam.pidash.ui.live.insertSkillDraft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SkillPickerTest {
    private val skills = listOf(
        LiveSkill("pdf-tools", "Extract and render PDF files"),
        LiveSkill("dashboard-ui-ux", "Design dashboard interfaces"),
        LiveSkill("pdf-tools", "duplicate"),
        LiveSkill("review", "Review code changes"),
    )

    @Test fun filtersByNameAndDescriptionIgnoringCase() {
        assertEquals(listOf("pdf-tools"), filterSkills(skills, "PDF").map { it.name })
        assertEquals(listOf("dashboard-ui-ux"), filterSkills(skills, "dashboard").map { it.name })
        assertEquals(listOf("review"), filterSkills(skills, "CODE").map { it.name }.distinct())
    }

    @Test fun removesDuplicateNamesAndSorts() {
        assertEquals(listOf("dashboard-ui-ux", "pdf-tools", "review"), filterSkills(skills, "").map { it.name })
    }

    @Test fun insertsTheRealSkillInvocationBeforeExistingDraft() {
        assertEquals("/skill:pdf-tools ", insertSkillDraft("", "pdf-tools"))
        assertEquals("/skill:pdf-tools extract this", insertSkillDraft("extract this", "pdf-tools"))
        assertEquals("/skill:review ", insertSkillDraft("  ", "review"))
    }

    @Test fun refusesInjectionShapedNames() {
        assertNull(insertSkillDraft("", "pdf\nother"))
        assertNull(insertSkillDraft("", " "))
        assertNull(insertSkillDraft("", "../secret"))
    }
}
