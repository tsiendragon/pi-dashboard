package com.sam.pidash

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import android.util.TypedValue
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import com.sam.pidash.ui.theme.PiDashTheme
import com.sam.pidash.ui.theme.PiType
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Native Android drawable previews. Custom masks/palettes simulate launchers, not real device acceptance. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-xhdpi")
class LauncherBrandingTest {
    @get:Rule val compose = createComposeRule()
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private fun icon(id: Int = R.mipmap.ic_launcher) = context.getDrawable(id)!!.mutate() as AdaptiveIconDrawable
    private fun bitmap(drawable: Drawable, size: Int): Bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also {
        drawable.setBounds(0, 0, size, size); drawable.draw(Canvas(it))
    }
    private fun pixels(bitmap: Bitmap) = IntArray(bitmap.width * bitmap.height).also {
        bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    }
    private fun preview(size: Int, shape: String = "system", themed: Boolean = false, dark: Boolean = false): Bitmap {
        val icon = icon()
        if (shape == "system" && !themed) return bitmap(icon, size)
        return Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { image ->
            val canvas = Canvas(image)
            val path = Path().apply {
                if (shape == "square") addRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), size * .23f, size * .23f, Path.Direction.CW)
                else addCircle(size / 2f, size / 2f, size / 2f, Path.Direction.CW)
            }
            canvas.clipPath(path)
            // Same layer overscan as AdaptiveIconDrawable; simulated masks do not resize the glyph independently.
            val inset = (size * AdaptiveIconDrawable.getExtraInsetFraction()).toInt()
            fun draw(layer: Drawable) { layer.setBounds(-inset, -inset, size + inset, size + inset); layer.draw(canvas) }
            if (themed) {
                canvas.drawColor(AndroidColor.parseColor(if (dark) "#203D35" else "#D6EAE4"))
                val mono = requireNotNull(icon.monochrome).mutate()
                mono.setTint(AndroidColor.parseColor(if (dark) "#B5D9CB" else "#264C3F"))
                draw(mono)
            } else { draw(icon.background); draw(icon.foreground) }
        }
    }
    @Composable private fun Sample(label: String, size: Int, shape: String = "system", themed: Boolean = false, dark: Boolean = false) {
        Column(Modifier.width(100.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Image(preview(size * 2, shape, themed, dark).asImageBitmap(), contentDescription = label, modifier = Modifier.size(size.dp))
            Text(label, style = PiType.caption)
        }
    }
    @Test fun launcherArtworkPreview() {
        compose.setContent { PiDashTheme(darkTheme = false) { Surface {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text("PiDash · 桌面图标", style = PiType.pageTitle)
                Row { Sample("圆形", 88, "circle"); Sample("圆角方形", 88, "square"); Sample("系统裁切", 88) }
                Text("小尺寸辨识度", style = PiType.footnote)
                Row(verticalAlignment = Alignment.Bottom) { Sample("24 dp", 24); Sample("32 dp", 32); Sample("48 dp", 48) }
            }
        } } }
        compose.onRoot().captureRoboImage("src/test/screenshots/launcher-branding.png")
    }
    @Test fun themedIconPreview() {
        compose.setContent { PiDashTheme(darkTheme = true) { Surface {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Text("Android 主题图标", style = PiType.pageTitle)
                Row { Sample("浅色示例", 88, "circle", themed = true); Sample("深色示例", 88, "circle", themed = true, dark = true) }
                Text("模拟系统配色，实际颜色由桌面与壁纸决定。", style = PiType.caption)
            }
        } } }
        compose.onRoot().captureRoboImage("src/test/screenshots/launcher-themed.png")
    }
    @Test fun entireMarkFitsAdaptiveSafeCircle() {
        val image = bitmap(context.getDrawable(R.drawable.ic_launcher_foreground)!!, 1080)
        val values = pixels(image)
        var ink = 0
        values.forEachIndexed { index, color ->
            if (AndroidColor.alpha(color) > 32) {
                ink++
                val dx = index % 1080 + .5 - 540; val dy = index / 1080 + .5 - 540
                assertTrue("Foreground outside 66dp safe circle", dx * dx + dy * dy <= 330.5 * 330.5)
            }
        }
        assertTrue(ink > 1000)
    }
    @Test fun monochromeUsesExactlyTheSameSilhouette() {
        val full = pixels(bitmap(context.getDrawable(R.drawable.ic_launcher_foreground)!!, 216))
        val mono = pixels(bitmap(context.getDrawable(R.drawable.ic_launcher_monochrome)!!, 216))
        assertArrayEquals(full.map { AndroidColor.alpha(it) }.toIntArray(), mono.map { AndroidColor.alpha(it) }.toIntArray())
    }
    @Test fun roundAndStandardResourcesStayConsistentAndExposeMonochrome() {
        assertNotNull(icon().monochrome)
        assertNotNull(icon(R.mipmap.ic_launcher_round).monochrome)
        assertTrue(bitmap(icon(), 192).sameAs(bitmap(icon(R.mipmap.ic_launcher_round), 192)))
    }
    @Test fun tinyPlatformIconKeepsBothBrandAndCursor() {
        val values = pixels(bitmap(icon(), 24))
        assertTrue(values.count { AndroidColor.red(it) > 210 && AndroidColor.green(it) in 130..220 && AndroidColor.blue(it) < 150 } >= 10)
        assertTrue(values.count { AndroidColor.green(it) > 140 && AndroidColor.blue(it) > 110 && AndroidColor.red(it) < 150 } >= 2)
    }
    private fun themeColor(attribute: Int): Int {
        val theme = context.resources.newTheme().apply { applyStyle(R.style.Theme_PiDash, true) }
        val value = TypedValue()
        assertTrue(theme.resolveAttribute(attribute, value, true))
        return value.data
    }
    @Test fun lightSplashRetainsPageBackgroundAndBrandedIconSurface() {
        assertEquals(AndroidColor.WHITE, themeColor(android.R.attr.windowSplashScreenBackground))
        assertEquals(context.getColor(R.color.launcher_background), themeColor(android.R.attr.windowSplashScreenIconBackgroundColor))
    }
    @Test @Config(qualifiers = "night")
    fun darkSplashRetainsPageBackgroundAndBrandedIconSurface() {
        assertEquals(AndroidColor.BLACK, themeColor(android.R.attr.windowSplashScreenBackground))
        assertEquals(context.getColor(R.color.launcher_background), themeColor(android.R.attr.windowSplashScreenIconBackgroundColor))
    }
}
