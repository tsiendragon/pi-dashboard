export interface ConversationMessage { id: string; role: string; text: string; images: Array<{ mimeType: string; data: string }> }
export interface ConversationTranscript {
  /** Messages a reader can read: the user's and the supervisor's own words. */
  messages: ConversationMessage[]
  /** Tool results left out of the reading view (terminal logs, JSON dumps). */
  omittedToolResults: number
}
/**
 * Read actual session-file messages and bridge message frames, not synthetic chat rows.
 *
 * Tool results are counted but not returned: one `task-journal` call dumps a page of
 * JSON that buries the exchange, and the dialog is a reading view of the conversation.
 * The full record stays one click away in the main session page.
 */
export function conversationMessages(entries: unknown[]): ConversationTranscript {
  const messages: ConversationMessage[] = []
  const countedToolResults = new Set<string>()
  let omittedToolResults = 0
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : undefined
    const raw = row.type === 'message' ? row.message : row.type === 'message_end' || row.type === 'message_update' ? data?.message : undefined
    if (!raw || typeof raw !== 'object') continue
    const message = raw as Record<string, unknown>
    if (typeof message.role !== 'string') continue
    const id = String(row.id || data?.entryId || message.id || index)
    // One result can arrive twice (snapshot + live frame); it is still one row.
    if (message.role === 'toolResult') {
      if (!countedToolResults.has(id)) {
        countedToolResults.add(id)
        omittedToolResults += 1
      }
      continue
    }
    const blocks = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []
    const text = typeof message.content === 'string' ? message.content : blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    const images = blocks.filter(block => block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string').map(block => ({ mimeType: String(block.mimeType), data: String(block.data) }))
    if (!text && !images.length) continue
    const existing = messages.findIndex(item => item.id === id)
    const projected = { id, role: message.role, text, images }
    if (existing >= 0) messages[existing] = projected
    else messages.push(projected)
  }
  return { messages, omittedToolResults }
}
