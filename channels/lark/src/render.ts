/**
 * Event -> outbound text. Mirrors the web frontend's transcript rules:
 * only assistant reply text is surfaced; thinking and tool/script output are
 * dropped (the "compact reading" the mobile client defaults to).
 */

/** Conservative per-message text limit; kept below Lark's documented ceiling. */
export const LARK_TEXT_LIMIT = 4000

/** Extract human text from a pi message `content` (string or parts array). */
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Return the assistant reply body for an event, or undefined when the event is
 * not a completed assistant message.
 *
 * pi emits: agent_start, message_start|update|end, tool_execution_start|update|end.
 */
export function extractAssistantText(eventType: string, data: unknown): string | undefined {
  if (eventType !== 'message_end') return undefined
  if (!data || typeof data !== 'object') return undefined
  const message = (data as { message?: unknown }).message
  if (!message || typeof message !== 'object') return undefined
  const record = message as Record<string, unknown>
  if (record.role !== 'assistant') return undefined
  const text = textContent(record.content).trim()
  return text || undefined
}

/** Split text into transport-sized chunks, preferring line/word boundaries. */
export function chunkText(text: string, limit: number = LARK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).replace(/^\n/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
