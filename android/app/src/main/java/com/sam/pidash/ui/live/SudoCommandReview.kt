package com.sam.pidash.ui.live

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

internal data class SudoCommandReview(val preview: String, val rawArguments: String)

/** Display only. Execution still uses the immutable argv bound to the request on the host. */
internal fun sudoCommandReview(raw: String?): SudoCommandReview? = runCatching {
    require(raw != null && raw.length <= 32768)
    val array = Json.parseToJsonElement(raw) as? JsonArray ?: error("Expected argv")
    val argv = array.map { element ->
        val value = element as? JsonPrimitive ?: error("Expected string")
        require(value.isString && '\u0000' !in value.content)
        value.content
    }
    require(argv.isNotEmpty() && argv.first().startsWith('/'))
    // Quotes show argument boundaries. Control/bidi characters are escaped visibly, not executed.
    fun quote(arg: String): String = when {
        arg.any { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() } -> JsonPrimitive(arg).toString()
        arg.isNotEmpty() && arg.all { it in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:=@%+,-" } -> arg
        else -> "'" + arg.replace("'", "'\\''") + "'"
    }
    SudoCommandReview(
        preview = sudoVisibleText("sudo -A -k -- " + argv.joinToString(" ", transform = ::quote)),
        rawArguments = sudoVisibleText(array.joinToString(",\n", prefix = "[\n", postfix = "\n]") { "  $it" }),
    )
}.getOrNull()

/** Keep spoofing/terminal controls visible in display text without changing the approved request. */
internal fun sudoVisibleText(text: String): String = buildString {
    for (char in text) {
        if ((char.isISOControl() && char != '\n' && char != '\t') || Character.getType(char) == Character.FORMAT.toInt()) {
            append("\\u").append(char.code.toString(16).padStart(4, '0'))
        } else append(char)
    }
}
