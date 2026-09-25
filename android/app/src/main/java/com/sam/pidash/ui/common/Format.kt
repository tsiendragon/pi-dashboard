package com.sam.pidash.ui.common

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
private val MMDD = DateTimeFormatter.ofPattern("MM-dd")

/** "刚刚 / 3 分钟前 / 2 小时前 / 4 天前 / 03-21" */
fun relativeTime(millis: Long, now: Long = System.currentTimeMillis()): String {
    if (millis <= 0L) return ""
    val diff = now - millis
    return when {
        diff < TimeUnit.MINUTES.toMillis(1) -> "刚刚"
        diff < TimeUnit.HOURS.toMillis(1) -> "${TimeUnit.MILLISECONDS.toMinutes(diff)} 分钟前"
        diff < TimeUnit.DAYS.toMillis(1) -> "${TimeUnit.MILLISECONDS.toHours(diff)} 小时前"
        diff < TimeUnit.DAYS.toMillis(7) -> "${TimeUnit.MILLISECONDS.toDays(diff)} 天前"
        else -> Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).format(MMDD)
    }
}

fun clockTime(millis: Long): String =
    if (millis <= 0L) "" else Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).format(HHMM)
