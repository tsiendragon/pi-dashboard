/**
 * Compact projection for the Android client's initial sync.
 *
 * Thinking prose and full tool arguments/results dominate long transcripts but
 * are only needed when the user opens the full record. The registry keeps the
 * authoritative full entries; this projection keeps final prose, tool identity,
 * status and a marker telling the client that detail can be loaded on demand.
 */
type JsonRecord = Record<string, unknown>

function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function omit(entry: JsonRecord, key: 'thinking' | 'args' | 'output' | 'images'): void {
  const current = object(entry.piOmitted) ?? {}
  entry.piOmitted = { ...current, [key]: true }
}

function compactMessage(message: JsonRecord): void {
  const role = typeof message.role === 'string' ? message.role : ''
  const content = Array.isArray(message.content) ? message.content : undefined
  if (role === 'toolResult') {
    if (message.content !== undefined) {
      // Tool output stays redacted, but image placeholders let Android offer
      // the same on-demand full-detail path as user/assistant image parts.
      const nextContent = content?.map(part => {
        const record = object(part)
        return record?.type === 'image'
          ? { type: 'image', mimeType: record.mimeType, piImageOmitted: true }
          : part
      }).filter(part => object(part)?.type === 'image') ?? []
      message.content = nextContent
      omit(message, 'output')
      if (nextContent.length > 0) omit(message, 'images')
    }
    return
  }
  if (!content) return
  const nextContent = content.map(part => {
    const record = object(part)
    if (!record) return part
    if (record.type === 'image') {
      return { type: 'image', mimeType: record.mimeType, piImageOmitted: true }
    }
    if (record.type === 'thinking') {
      // Keep the slot so the activity view still knows a reasoning block existed;
      // blank text plus piOmitted.thinking means "load on demand", not "hidden model".
      return { ...record, thinking: '' }
    }
    if (record.type === 'toolCall') {
      const next = { ...record }
      if (next.arguments !== undefined) {
        delete next.arguments
        return { ...next, piArgsOmitted: true }
      }
      return next
    }
    return record
  })
  message.content = nextContent
  if (nextContent.some(part => object(part)?.type === 'thinking')) omit(message, 'thinking')
  if (nextContent.some(part => object(part)?.piArgsOmitted === true)) omit(message, 'args')
  if (nextContent.some(part => object(part)?.piImageOmitted === true)) omit(message, 'images')
}

function compactTurnEndEvent(entry: JsonRecord): void {
  const data = object(entry.data)
  if (!data || !('context' in data)) return
  const { context: _omitted, ...rest } = data
  entry.data = rest
}

function compactToolEvent(entry: JsonRecord): void {
  const data = object(entry.data)
  if (!data) return
  if (data.args !== undefined) {
    const next = { ...data }
    delete next.args
    entry.data = next
    omit(entry, 'args')
  }
  if (data.result !== undefined || data.partialResult !== undefined) {
    const next = object(entry.data) ?? {}
    delete next.result
    delete next.partialResult
    entry.data = next
    omit(entry, 'output')
  }
}

export function compactEntry(raw: unknown): unknown {
  const entry = object(structuredClone(raw))
  if (!entry) return raw
  const type = typeof entry.type === 'string' ? entry.type : ''
  const data = object(entry.data)
  const message = type === 'message' ? object(entry.message)
    : type === 'message_update' || type === 'message_end' ? object(data?.message)
      : undefined
  if (message) {
    compactMessage(message)
    if (object(message.piOmitted)?.thinking) omit(entry, 'thinking')
    if (object(message.piOmitted)?.args) omit(entry, 'args')
    if (object(message.piOmitted)?.output) omit(entry, 'output')
    if (object(message.piOmitted)?.images) omit(entry, 'images')
  }
  if (type.startsWith('tool_execution_')) compactToolEvent(entry)
  if (type === 'turn_end') compactTurnEndEvent(entry)
  return entry
}

export function compactEvent(raw: unknown): unknown {
  const event = object(structuredClone(raw))
  if (!event) return raw
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'message_end' || type === 'message_update') {
    const data = object(event.data)
    const message = object(data?.message)
    if (message) {
      compactMessage(message)
      if (object(message.piOmitted)?.thinking) omit(event, 'thinking')
      if (object(message.piOmitted)?.args) omit(event, 'args')
      if (object(message.piOmitted)?.images) omit(event, 'images')
    }
  }
  if (type.startsWith('tool_execution_')) compactToolEvent(event)
  if (type === 'turn_end') compactTurnEndEvent(event)
  return event
}

/** Add the marker that Android uses to show the compact-sync banner. */
export function compactDetail(raw: unknown): unknown {
  const detail = object(structuredClone(raw))
  if (!detail) return raw
  if (Array.isArray(detail.entries)) detail.entries = detail.entries.map(compactEntry)
  detail.compact = true
  return detail
}

export function compactBrowserMessage(message: { type: string; data: unknown }): { type: string; data: unknown } {
  if (message.type === 'live_session_snapshot') return { ...message, data: compactDetail(message.data) }
  if (message.type === 'live_session_event') {
    const data = object(message.data)
    if (data && data.event !== undefined) return { ...message, data: { ...data, event: compactEvent(data.event) } }
  }
  return message
}
