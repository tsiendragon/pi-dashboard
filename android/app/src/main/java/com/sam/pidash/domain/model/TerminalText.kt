package com.sam.pidash.domain.model

/**
 * Turns a PTY byte stream into something readable in a Text composable.
 *
 * A terminal is a paint program, not a log: the same bytes that draw a progress bar carry
 * cursor moves and colour codes. We keep the printable text, drop escape sequences, and
 * turn a bare carriage return into a line break — good enough for a prompt-and-answer
 * script, and honest: the console says the view is simplified and not a full terminal.
 */
private val CSI = Regex("""\u001B\[[0-9;?]*[ -/]*[@-~]""")
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
