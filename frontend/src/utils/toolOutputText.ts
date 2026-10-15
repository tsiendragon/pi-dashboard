/**
 * Tool output reaches the UI in whatever shape the tool emitted: plain text, a
 * serialized envelope of text parts, or text whose line breaks were escaped
 * into the two characters `\n` on the way through the session file. The
 * transcript only needs the readable text inside, so each shape is narrowed to
 * one displayable string (see `normalizeToolOutputText`).
 */

/** Keys that carry human-readable output, most specific first. */
const TEXT_KEYS = ['text', 'result', 'output', 'content', 'message', 'error', 'stdout', 'stderr'] as const

type Extracted = {
  text: string
  /** Whether any real string was part of the extraction. */
  fromString: boolean
}

function textPart(value: unknown): Extracted {
  if (typeof value === 'string') return { text: value, fromString: true }
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), fromString: false }
  if (Array.isArray(value)) {
    const parts = value.map(textPart).filter(part => part.text.trim())
    return {
      text: parts.map(part => part.text).join('\n\n'),
      fromString: parts.some(part => part.fromString),
    }
  }
  if (!value || typeof value !== 'object') return { text: '', fromString: false }
  const record = value as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    const part = textPart(record[key])
    if (part.text.trim()) return part
  }
  return { text: '', fromString: false }
}

/**
 * Readable text of a serialized envelope such as `[{ url, result: '...' }]`,
 * or undefined when the text is not one (or holds no text worth extracting).
 */
function envelopeText(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed || (trimmed[0] !== '[' && trimmed[0] !== '{' && trimmed[0] !== '"')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  const extracted = typeof parsed === 'string' ? { text: parsed, fromString: true } : textPart(parsed)
  // Numbers and booleans are structured data, not output text: a payload built
  // only from them (`[1, 2, 3]`) stays verbatim.
  if (!extracted.fromString) return undefined
  const text = extracted.text.trim()
  return text || undefined
}

/** Restores line breaks that the session file escaped into two characters. */
function unescapeLines(text: string): string {
  if (text.includes('\n')) return text
  if (!/\\[nrt]/.test(text)) return text
  return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, '\t')
}

/**
 * Displayable text of one tool result.
 *
 * An envelope is unwrapped to the text it carries, and escaped line breaks are
 * restored when the text holds no real ones — otherwise a whole page arrives as
 * a single line of `\n`-riddled JSON. Text that is already readable is returned
 * unchanged apart from trailing whitespace.
 */
export function normalizeToolOutputText(raw: string): string {
  if (!raw) return ''
  const text = envelopeText(raw) ?? raw
  return unescapeLines(text).replace(/\s+$/, '')
}