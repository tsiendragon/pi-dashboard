import type { LiveSessionDetail, LiveSessionStatus } from '../shared/src/live-sessions.js'

export type MachinePreview = {
  sessionId: string
  status: LiveSessionStatus
  observedAt: number
  messages: { role: 'user' | 'assistant'; text: string }[]
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_TEXT_BYTES = 512
// Reserve room for the wire envelope (requestId and duplicated sessionId).
const MAX_PREVIEW_BYTES = 5800

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedText(value: string): string {
  let text = ''
  let bytes = 0
  for (const point of value) {
    const code = point.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) continue // malformed UTF-16 is not a code point
    const size = Buffer.byteLength(point, 'utf8')
    if (bytes + size > MAX_TEXT_BYTES) break
    text += point
    bytes += size
  }
  return text
}

function completedMessage(entry: unknown): MachinePreview['messages'][number] | undefined {
  const item = record(entry)
  const message = item?.type === 'message' ? record(item.message)
    : item?.type === 'message_end' ? record(record(item.data)?.message) : undefined
  if (message?.role !== 'user' && message?.role !== 'assistant') return undefined
  const content = message.content
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content) && content.length > 0 && content.every(part => {
    const block = record(part)
    return block?.type === 'text' && typeof block.text === 'string'
  })) text = content.map(part => (part as { text: string }).text).join('')
  else return undefined
  text = boundedText(text)
  return text ? { role: message.role, text } : undefined
}

/** Fail closed on detached/replaced sessions; never expose the registry detail itself. */
export function projectMachinePreview(
  get: (processInstanceId: string) => LiveSessionDetail | undefined,
  processInstanceId: string,
  sessionId: string,
  now: () => number = Date.now,
): MachinePreview | undefined {
  if (typeof processInstanceId !== 'string' || !SAFE_ID.test(processInstanceId)
    || typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return undefined
  const detail = get(processInstanceId)
  if (!detail || detail.summary?.sessionId !== sessionId || !Array.isArray(detail.entries)) return undefined
  const status = detail.summary.status
  if (status !== 'idle' && status !== 'running' && status !== 'reconnecting') return undefined
  const observedAt = now()
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return undefined
  const messages: MachinePreview['messages'] = []
  for (let i = detail.entries.length - 1; i >= 0 && messages.length < 8; i--) {
    const message = completedMessage(detail.entries[i])
    if (message) messages.unshift(message)
  }
  const preview: MachinePreview = { sessionId, status, observedAt, messages }
  // Escaped control characters can make JSON larger than its UTF-8 text budget.
  // Prefer retaining recent messages; trim only complete code points.
  while (Buffer.byteLength(JSON.stringify(preview), 'utf8') > MAX_PREVIEW_BYTES && messages.length) {
    if ([...messages[0].text].length <= 1) messages.shift()
    else messages[0].text = [...messages[0].text].slice(0, -1).join('')
  }
  return preview
}
