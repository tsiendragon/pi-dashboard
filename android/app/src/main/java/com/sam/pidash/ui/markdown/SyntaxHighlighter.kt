package com.sam.pidash.ui.markdown

/**
 * A small, dependency-free code highlighter.
 *
 * The WebUI uses highlight.js; pulling that into a Compose `Text` is impossible,
 * so this tokenises the handful of languages pi actually writes and leaves
 * everything else as plain text. It is a pure function of (code, language) so the
 * token stream can be unit tested without Compose.
 */
enum class CodeTokenKind { Plain, Keyword, String, Comment, Number, Type, Function }

data class CodeToken(val start: Int, val end: Int, val kind: CodeTokenKind)

object SyntaxHighlighter {
    /** Highlighting is skipped above these sizes; a huge block stays readable instead of janky. */
    const val MAX_CHARS = 20_000
    const val MAX_LINES = 600

    private class Spec(
        val keywords: Set<String> = emptySet(),
        val types: Set<String> = emptySet(),
        val lineComments: List<String> = listOf("//"),
        val blockComment: Pair<String, String>? = "/*" to "*/",
        val hashComments: Boolean = false,
    )

    private val COMMON = setOf(
        "if", "else", "for", "while", "return", "break", "continue", "in", "not", "and", "or",
        "true", "false", "null", "None", "True", "False", "nil", "try", "catch", "finally",
        "throw", "throws", "import", "from", "export", "default", "new", "this", "self", "super",
        "switch", "case", "do", "as", "is", "typeof", "await", "async", "yield", "lambda",
    )

    private fun spec(language: String?): Spec? = when (language?.lowercase()) {
        null, "" -> null
        // Plain-text blocks must stay plain: colouring a log would be noise.
        "text", "txt", "plain", "plaintext", "log", "output", "none" -> null
        "kotlin", "kt", "kts" -> Spec(COMMON + setOf("fun", "val", "var", "class", "object", "data", "when",
            "interface", "companion", "override", "private", "public", "internal", "suspend", "it", "init",
            "sealed", "abstract", "lateinit", "const", "inline", "reified", "by", "where", "enum", "package"),
            types = setOf("String", "Int", "Long", "Double", "Float", "Boolean", "Unit", "List", "Map", "Set",
                "Any", "Nothing", "Flow", "Result"))
        "java" -> Spec(COMMON + setOf("public", "private", "protected", "static", "final", "void", "class",
            "interface", "extends", "implements", "package", "native", "synchronized", "instanceof", "enum"),
            types = setOf("String", "int", "long", "double", "float", "boolean", "char", "byte", "Object", "List", "Map"))
        "js", "javascript", "jsx", "ts", "typescript", "tsx" -> Spec(COMMON + setOf("function", "const", "let",
            "var", "class", "extends", "static", "interface", "type", "enum", "implements", "of", "void",
            "delete", "instanceof", "undefined", "implements", "readonly", "public", "private", "protected"),
            types = setOf("string", "number", "boolean", "any", "unknown", "never", "Promise", "Array", "Record"))
        "python", "py" -> Spec(COMMON + setOf("def", "class", "elif", "with", "pass", "global", "nonlocal",
            "assert", "raise", "except", "print", "del", "elif"), lineComments = listOf("#"), blockComment = null)
        "bash", "sh", "shell", "zsh", "console", "shell-session" -> Spec(
            setOf("if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
                "function", "return", "export", "local", "source", "set", "unset", "read", "echo", "cd", "sudo"),
            lineComments = listOf("#"), blockComment = null)
        "json", "jsonl" -> Spec(lineComments = emptyList(), blockComment = null,
            keywords = setOf("true", "false", "null"))
        "yaml", "yml", "toml", "ini", "conf", "cfg", "properties" -> Spec(
            keywords = setOf("true", "false", "null", "yes", "no", "on", "off"),
            lineComments = listOf("#"), blockComment = null)
        "sql" -> Spec(setOf("select", "from", "where", "insert", "into", "values", "update", "set", "delete",
            "create", "table", "index", "join", "left", "right", "inner", "outer", "on", "group", "by",
            "order", "limit", "offset", "and", "or", "not", "null", "as", "distinct", "having", "case", "when"),
            lineComments = listOf("--"), blockComment = "/*" to "*/")
        "go", "golang" -> Spec(COMMON + setOf("func", "package", "defer", "go", "chan", "select", "struct",
            "interface", "map", "range", "type", "var", "const"), types = setOf("string", "int", "int64",
            "float64", "bool", "byte", "error", "any"))
        "rust", "rs" -> Spec(COMMON + setOf("fn", "let", "mut", "impl", "trait", "struct", "enum", "match",
            "use", "pub", "crate", "mod", "where", "loop", "move", "ref", "unsafe", "dyn", "async"),
            types = setOf("String", "str", "i32", "i64", "u32", "u64", "f64", "bool", "Vec", "Option", "Result"))
        "c", "h", "cpp", "cc", "hpp", "c++" -> Spec(COMMON + setOf("int", "void", "struct", "typedef",
            "sizeof", "unsigned", "signed", "const", "static", "extern", "namespace", "template", "class",
            "public", "private", "protected", "virtual", "auto"), types = setOf("char", "float", "double",
            "long", "short", "bool"))
        "diff", "patch" -> Spec(lineComments = emptyList(), blockComment = null)
        "xml", "html", "svg" -> Spec(lineComments = emptyList(), blockComment = "<!--" to "-->")
        "css", "scss" -> Spec(lineComments = emptyList(), blockComment = "/*" to "*/")
        "markdown", "md" -> Spec(lineComments = emptyList(), blockComment = null)
        else -> Spec(COMMON + setOf("def", "fn", "func", "package", "import"))
    }

    fun highlight(code: String, language: String?): List<CodeToken> {
        val spec = spec(language) ?: return emptyList()
        if (code.length > MAX_CHARS || code.count { it == '\n' } > MAX_LINES) return emptyList()
        val tokens = mutableListOf<CodeToken>()
        var i = 0
        fun emit(start: Int, end: Int, kind: CodeTokenKind) {
            if (end > start) tokens += CodeToken(start, end, kind)
        }
        while (i < code.length) {
            val ch = code[i]
            val lineComment = spec.lineComments.firstOrNull { code.startsWith(it, i) }
            if (lineComment != null) {
                val end = code.indexOf('\n', i).let { if (it < 0) code.length else it }
                emit(i, end, CodeTokenKind.Comment); i = end; continue
            }
            val block = spec.blockComment
            if (block != null && code.startsWith(block.first, i)) {
                val close = code.indexOf(block.second, i + block.first.length)
                val end = if (close < 0) code.length else close + block.second.length
                emit(i, end, CodeTokenKind.Comment); i = end; continue
            }
            if (ch == '"' || ch == '\'' || ch == '`') {
                val triple = ch == '"' && code.startsWith("\"\"\"", i)
                val quote = if (triple) "\"\"\"" else ch.toString()
                var j = i + quote.length
                while (j < code.length) {
                    if (code[j] == '\\') { j += 2; continue }
                    if (code.startsWith(quote, j)) { j += quote.length; break }
                    j++
                }
                emit(i, minOf(j, code.length), CodeTokenKind.String); i = minOf(j, code.length); continue
            }
            if (ch.isDigit()) {
                var j = i
                while (j < code.length && (code[j].isLetterOrDigit() || code[j] in "._")) j++
                emit(i, j, CodeTokenKind.Number); i = j; continue
            }
            if (ch.isLetter() || ch == '_' || ch == '$' || ch == '@') {
                var j = i + 1
                while (j < code.length && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '$')) j++
                val word = code.substring(i, j)
                val kind = when {
                    word.lowercase() in spec.keywords || word in spec.keywords -> CodeTokenKind.Keyword
                    word in spec.types -> CodeTokenKind.Type
                    j < code.length && code[j] == '(' -> CodeTokenKind.Function
                    else -> CodeTokenKind.Plain
                }
                emit(i, j, kind); i = j; continue
            }
            i++
        }
        return tokens
    }
}
