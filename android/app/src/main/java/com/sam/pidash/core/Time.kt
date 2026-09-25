package com.sam.pidash.core

import java.time.OffsetDateTime

/** Parse an ISO-8601 timestamp (with or without fractional seconds) to epoch millis. */
fun parseIso(value: String?): Long? {
    if (value.isNullOrBlank()) return null
    return runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
}

/** Slot keys look like `chat-1-1713400000000`; the trailing number is unix millis. */
fun timestampFromKey(key: String): Long =
    key.split('-').lastOrNull()?.toLongOrNull() ?: 0L

fun nowMillis(): Long = System.currentTimeMillis()
