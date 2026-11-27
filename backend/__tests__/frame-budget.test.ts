import { describe, expect, it } from 'vitest'
import {
  CLIENT_FRAME_LIMIT_BYTES,
  SERVER_FRAME_BUDGET_BYTES,
  trimDetailToBudget,
} from '../live-sessions/frame-budget.js'

/** One entry whose serialized size is roughly `chars` bytes. */
function bigEntry(id: string, chars: number) {
  return { type: 'message', id, text: 'x'.repeat(chars) }
}

describe('live-session frame budget', () => {
  it('keeps a small projection untouched', () => {
    const detail = { summary: { processInstanceId: 'p' }, entries: [bigEntry('a', 10), bigEntry('b', 10)] }
    const result = trimDetailToBudget(detail)
    expect(result.value).toBe(detail)
    expect(result.droppedEntries).toBe(0)
    expect(result.keptEntries).toBe(2)
    expect(result.overBudget).toBe(false)
  })

  it('leaves non-entry-shaped payloads alone', () => {
    const payload = { hello: 'world' }
    const result = trimDetailToBudget(payload)
    expect(result.value).toBe(payload)
    expect(result.droppedEntries).toBe(0)
  })

  it('drops the oldest entries first and keeps the tail', () => {
    const entrySize = 200_000
    const count = 100
    const entries = Array.from({ length: count }, (_, i) => bigEntry(`e${i}`, entrySize))
    const detail = { summary: { processInstanceId: 'p' }, entries }

    const result = trimDetailToBudget(detail)
    const kept = (result.value as typeof detail).entries
    const serialized = JSON.stringify(result.value).length

    expect(serialized).toBeLessThanOrEqual(SERVER_FRAME_BUDGET_BYTES)
    expect(kept.length).toBeLessThan(count)
    expect(result.droppedEntries).toBe(count - kept.length)
    // The newest entry survives; the oldest is what gets dropped.
    expect(kept[kept.length - 1]).toEqual(entries[count - 1])
    expect(kept).not.toContainEqual(entries[0])
    // Caller-owned entries are not mutated.
    expect(entries).toHaveLength(count)
  })

  it('always keeps a usable tail even when entries are individually huge', () => {
    // Each entry alone is larger than the budget; the floor still keeps one.
    const entries = Array.from({ length: 5 }, (_, i) => bigEntry(`h${i}`, SERVER_FRAME_BUDGET_BYTES))
    const result = trimDetailToBudget({ summary: {}, entries })
    expect(result.keptEntries).toBe(1)
    expect(result.overBudget).toBe(true)
  })

  it('stays well under the client limit it exists to protect', () => {
    expect(SERVER_FRAME_BUDGET_BYTES).toBeLessThan(CLIENT_FRAME_LIMIT_BYTES)
    expect(SERVER_FRAME_BUDGET_BYTES * 2).toBeLessThanOrEqual(CLIENT_FRAME_LIMIT_BYTES)
  })

  it('trims an oversized Chinese payload by actual UTF-8 bytes', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      type: 'message',
      id: `zh-${i}`,
      text: '中'.repeat(100_000),
    }))
    const detail = { summary: { title: '会话'.repeat(1000) }, entries }
    const inputBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8')
    expect(inputBytes).toBeGreaterThan(SERVER_FRAME_BUDGET_BYTES * 3)

    const result = trimDetailToBudget(detail)
    const outputBytes = Buffer.byteLength(JSON.stringify(result.value), 'utf8')

    expect(result.overBudget).toBe(false)
    expect(result.keptEntries).toBeGreaterThan(0)
    expect(result.keptEntries).toBeLessThan(entries.length)
    expect(outputBytes).toBeLessThanOrEqual(SERVER_FRAME_BUDGET_BYTES)
  })

  it('does not pass the original 4000 by 1500 Chinese-character case over the client limit', () => {
    const entries = Array.from({ length: 4000 }, (_, i) => ({
      type: 'message',
      id: `repro-${i}`,
      text: '汉'.repeat(1500),
    }))
    const detail = { summary: { processInstanceId: 'p' }, entries }
    const serializedInput = JSON.stringify(detail)

    // These are the original false-positive conditions: UTF-16 fits the server
    // budget while the wire representation exceeds the Android client limit.
    expect(serializedInput.length).toBeLessThanOrEqual(SERVER_FRAME_BUDGET_BYTES)
    expect(Buffer.byteLength(serializedInput, 'utf8')).toBeGreaterThan(CLIENT_FRAME_LIMIT_BYTES)

    const result = trimDetailToBudget(detail)
    const outputBytes = Buffer.byteLength(JSON.stringify(result.value), 'utf8')

    expect(result.overBudget).toBe(false)
    expect(result.keptEntries).toBeLessThan(entries.length)
    expect(result.droppedEntries).toBe(entries.length - result.keptEntries)
    expect(outputBytes).toBeLessThanOrEqual(SERVER_FRAME_BUDGET_BYTES)
    expect(outputBytes).toBeLessThan(CLIENT_FRAME_LIMIT_BYTES)
  })

  it('preserves ASCII trimming behavior', () => {
    const entries = Array.from({ length: 10 }, () => bigEntry('ascii', 1000))
    const result = trimDetailToBudget({ summary: {}, entries }, 4096)
    const kept = (result.value as { entries: unknown[] }).entries

    expect(result.overBudget).toBe(false)
    expect(result.keptEntries).toBe(3)
    expect(result.droppedEntries).toBe(7)
    expect(kept).toEqual(entries.slice(-3))
    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThanOrEqual(4096)
  })

  it('keeps mixed Chinese and English content within the UTF-8 budget', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({
      type: 'message',
      id: `mixed-${i}`,
      text: '中文 mixed ASCII 内容'.repeat(4000),
    }))
    const detail = { summary: { title: 'mixed 混排' }, entries }
    expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeGreaterThan(SERVER_FRAME_BUDGET_BYTES)

    const result = trimDetailToBudget(detail)

    expect(result.overBudget).toBe(false)
    expect(result.keptEntries).toBeGreaterThan(0)
    expect(result.keptEntries).toBeLessThan(entries.length)
    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThanOrEqual(SERVER_FRAME_BUDGET_BYTES)
  })
})
