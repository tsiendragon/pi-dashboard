package com.sam.pidash.domain.model

/**
 * Turns a PTY byte stream into something readable in a Text composable.
 *
 * A terminal is a paint program, not a log: the same bytes that draw a progress bar carry
 * cursor moves and colour codes. We keep the printable text, drop escape sequences, and
 * turn a bare carriage return into a line break — good enough for a prompt-and-answer
 * script, and honest: the console says the view is simplified and not a full terminal.
 */
private val CSI = Regex("""\u001B\[[0-9;?<=>!]*[ -/]*[@-~]""")
private val OSC = Regex("""\u001B\][^\u0007\u001B]*(\u0007|\u001B\\)""")
private val ESC_SINGLE = Regex("""\u001B[()][A-Za-z0-9]""")
private val ESC_OTHER = Regex("""\u001B[@-_]""")

/** Strips control sequences; keeps text, tabs and newlines. */
fun terminalDisplay(raw: String): String = raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_SINGLE, "")
    .replace(ESC_OTHER, "")
    .replace("\r\n", "\n")
    .replace('\r', '\n')
    .replace("\b", "")
    .filter { it == '\n' || it == '\t' || it >= ' ' }

/**
 * Appends PTY chunks to a capped, readable buffer.
 *
 * Chunk boundaries are arbitrary, so an escape sequence can be split across two reads; the
 * unfinished tail is held back instead of briefly rendering `[3` as text. Sanitising each
 * chunk (rather than the whole 200 k buffer on every frame) keeps a chatty script from
 * turning every output event into a full-buffer regex pass on the phone.
 */
class TerminalTextBuffer(private val limit: Int = 200_000) {
    private val visible = StringBuilder()
    private val carry = StringBuilder()

    fun append(chunk: String): String {
        carry.append(chunk)
        val pending = carry.toString()
        val cut = incompleteEscapeStart(pending)
        val safe = if (cut < 0) pending else pending.substring(0, cut)
        carry.setLength(0)
        // A "sequence" that never ends is a broken stream, not something to hide forever.
        if (cut >= 0 && pending.length - cut <= 256) carry.append(pending, cut, pending.length)
        if (safe.isNotEmpty()) visible.append(terminalDisplay(safe))
        if (visible.length > limit) visible.delete(0, visible.length - limit)
        return visible.toString()
    }

    fun clear() { visible.setLength(0); carry.setLength(0) }
}

/** Index where a trailing, still-incomplete escape sequence starts, or -1. */
private fun incompleteEscapeStart(text: String): Int {
    val escape = text.lastIndexOf('\u001B')
    if (escape < 0) return -1
    val tail = text.substring(escape)
    return when {
        tail.length == 1 -> escape
        tail.startsWith("\u001B[") -> if (Regex("""\u001B\[[0-9;?<=>!]*[ -/]*""").matches(tail)) escape else -1
        tail.startsWith("\u001B]") -> if (tail.contains('\u0007') || tail.contains("\u001B\\")) -1 else escape
        tail.length < 3 -> escape
        else -> -1
    }
}
