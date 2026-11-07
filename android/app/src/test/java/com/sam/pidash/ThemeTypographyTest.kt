package com.sam.pidash

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import com.sam.pidash.ui.theme.PiType
import com.sam.pidash.ui.theme.PiTypography
import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeTypographyTest {
    @Test fun pageAndDialogTitlesFollowLiveHeader() {
        listOf(PiTypography.titleLarge, PiTypography.titleMedium, PiTypography.headlineSmall).forEach {
            assertEquals(PiType.pageTitle, it)
            assertEquals(15.sp, it.fontSize)
            assertEquals(22.sp, it.lineHeight)
        }
    }
    @Test fun bodyAndSecondaryTextUseReadingScale() {
        assertEquals(PiType.body, PiTypography.bodyLarge)
        assertEquals(PiType.body, PiTypography.bodyMedium)
        assertEquals(PiType.footnote, PiTypography.bodySmall)
        assertEquals(PiType.footnote, PiTypography.labelLarge)
        assertEquals(PiType.caption, PiTypography.labelSmall)
    }
    @Test fun everyMaterialRoleHasTheSameProseFamily() {
        listOf(PiTypography.displayLarge, PiTypography.displayMedium, PiTypography.displaySmall,
            PiTypography.headlineLarge, PiTypography.headlineMedium, PiTypography.headlineSmall,
            PiTypography.titleLarge, PiTypography.titleMedium, PiTypography.titleSmall,
            PiTypography.bodyLarge, PiTypography.bodyMedium, PiTypography.bodySmall,
            PiTypography.labelLarge, PiTypography.labelMedium, PiTypography.labelSmall).forEach {
            assertEquals(FontFamily.SansSerif, it.fontFamily)
        }
    }
    @Test fun codeKeepsItsOwnMonospacedFamily() {
        assertEquals(FontFamily.Monospace, PiType.mono.fontFamily)
        assertEquals(FontFamily.Monospace, PiType.monoMicro.fontFamily)
        assertEquals(14.sp, PiType.userMessage.fontSize)
        assertEquals(15.sp, PiType.body.fontSize)
    }
}
