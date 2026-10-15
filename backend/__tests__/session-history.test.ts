import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSessionHistoryPage, decodeHistoryCursor } from '../session-history.js'
import { parseSessionMessages } from '../session-store.js'

function msgLine(role: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    message: { role, content: [{ type: 'text', text }], timestamp: '2026-01-01T00:00:00Z' },
  })
}

function toolCallLine(id: string, name: string): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: { q: 1 } }],
      timestamp: '2026-01-01T00:00:01Z',
    },
  })
}

function toolResultLine(id: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      timestamp: '2026-01-01T00:00:02Z',
    },
  })
}

function writeSession(raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-history-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, raw)
  return file
}

describe('readSessionHistoryPage', () => {
  it('pages backwards from the newest rows to the start', () => {
    const raw = Array.from({ length: 7 }, (_, i) => msgLine('user', `u${i}`)).map(l => l + '\n').join('')
    const file = writeSession(raw)

    const page1 = readSessionHistoryPage(file, { rows: 3 })!
    expect(page1.messages.map(m => m.content)).toEqual(['u4', 'u5', 'u6'])
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = readSessionHistoryPage(file, { cursor: page1.nextCursor, rows: 3 })!
    expect(page2.messages.map(m => m.content)).toEqual(['u1', 'u2', 'u3'])
    expect(page2.hasMore).toBe(true)

    const page3 = readSessionHistoryPage(file, { cursor: page2.nextCursor, rows: 3 })!
    expect(page3.messages.map(m => m.content)).toEqual(['u0'])
    expect(page3.hasMore).toBe(false)
    expect(page3.nextCursor).toBeNull()

    // Concatenated pages match a full parse.
    const all = [...page3.messages, ...page2.messages, ...page1.messages].map(m => m.content)
    expect(all).toEqual(parseSessionMessages(file, 100).map(m => m.content))
  })

  it('skips a partial trailing line that is still being written', () => {
    const raw = msgLine('user', 'done') + '\n' + '{"type":"message","message":{"role":"user"'
    const file = writeSession(raw)
    const page = readSessionHistoryPage(file, { rows: 10 })!
    expect(page.messages.map(m => m.content)).toEqual(['done'])
    expect(page.nextCursor).toBeNull()
  })

  it('keeps page windows aligned when a row is larger than the initial read window', () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    const raw =
      msgLine('user', 'u0') + '\n' +
      toolCallLine('c1', 'bash') + '\n' +
      toolResultLine('c1', big) + '\n' +
      msgLine('user', 'u2') + '\n' +
      msgLine('assistant', 'u3') + '\n'
    const file = writeSession(raw)

    const page1 = readSessionHistoryPage(file, { rows: 3 })!
    expect(page1.messages.map(m => m.content)).toEqual(['🔧 bash', 'u2', 'u3'])
    // The tool call row paired with its result from the same window.
    expect(page1.messages[0].meta?.result).toBe(big.slice(0, 5000))

    const page2 = readSessionHistoryPage(file, { cursor: page1.nextCursor, rows: 3 })!
    expect(page2.messages.map(m => m.content)).toEqual(['u0'])
    expect(page2.nextCursor).toBeNull()
  })

  it('returns an empty page for empty or unreadable files', () => {
    const empty = writeSession('')
    expect(readSessionHistoryPage(empty, { rows: 5 })).toEqual({ messages: [], nextCursor: null, hasMore: false })

    const missing = readSessionHistoryPage('/nonexistent/session.jsonl', { rows: 5 })
    expect(missing).toBeNull()
  })

  it('treats cursors on rewritten (smaller) files as exhausted', () => {
    const raw1 = Array.from({ length: 5 }, (_, i) => msgLine('user', `a${i}`)).map(l => l + '\n').join('')
    const file = writeSession(raw1)
    const page1 = readSessionHistoryPage(file, { rows: 2 })!
    expect(page1.nextCursor).not.toBeNull()

    writeFileSync(file, msgLine('user', 'fresh') + '\n')
    const page2 = readSessionHistoryPage(file, { cursor: page1.nextCursor, rows: 2 })!
    expect(page2).toEqual({ messages: [], nextCursor: null, hasMore: false })
  })

  it('ignores malformed cursor strings', () => {
    const file = writeSession(msgLine('user', 'x') + '\n')
    expect(readSessionHistoryPage(file, { cursor: 'nonsense', rows: 5 })).toEqual({ messages: [], nextCursor: null, hasMore: false })
  })

  it('decodes the cursor it encodes', () => {
    const decoded = decodeHistoryCursor('b:123:456')
    expect(decoded).toEqual({ offset: 123, size: 456 })
  })
})