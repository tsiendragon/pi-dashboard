import { describe, expect, it } from 'vitest'
import { emptyThinkingLabel, groupLiveToolEntries, mergeThinkingParts } from '../features/live-sessions/LiveSessionPage'

function assistant(id: string, calls: Array<{ id: string; name: string }>): Record<string, unknown> {
  return {
    type: 'message',
    id,
    message: {
      role: 'assistant',
      timestamp: '2026-09-10T23:48:00.000Z',
      content: calls.map(call => ({ type: 'toolCall', id: call.id, name: call.name, arguments: { command: `${call.name} --check` } })),
    },
  }
}

function result(id: string, name: string): Record<string, unknown> {
  return {
    type: 'message',
    message: { role: 'toolResult', toolCallId: id, toolName: name, content: 'ok', timestamp: '2026-09-10T23:48:01.000Z' },
  }
}

describe('mergeThinkingParts', () => {
  it('combines adjacent empty and non-empty thinking blocks into one block', () => {
    expect(mergeThinkingParts([
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: '' },
      { type: 'thinking', thinking: 'first reasoning' },
      { type: 'thinking', thinking: 'second reasoning' },
      { type: 'text', text: 'answer' },
    ])).toEqual([
      { type: 'thinking', thinking: 'first reasoning\nsecond reasoning', emptyThinkingCount: 2 },
      { type: 'text', text: 'answer' },
    ])
  })

  it('compresses empty thinking frames into a bounded emoji label', () => {
    expect(emptyThinkingLabel(1)).toBe('🤔')
    expect(emptyThinkingLabel(4)).toBe('🤔🤔🤔🤔')
    expect(emptyThinkingLabel(12)).toBe('🤔🤔🤔🤔🤔🤔 ×12')
  })
})

describe('groupLiveToolEntries', () => {
  it('keeps separate tool calls as separate timeline rows', () => {
    const { items: timeline } = groupLiveToolEntries([
      assistant('assistant-1', [{ id: 'call-1', name: 'bash' }]),
      result('call-1', 'bash'),
      assistant('assistant-2', [{ id: 'call-2', name: 'read' }]),
      result('call-2', 'read'),
      assistant('assistant-3', [{ id: 'call-3', name: 'git' }]),
      result('call-3', 'git'),
    ])

    expect(timeline.some(item => item.type === 'toolGroup')).toBe(false)
    expect(timeline.filter(item => item.type === 'entry')).toHaveLength(3)
  })

  it('groups multiple tool calls emitted in one assistant message', () => {
    const { items: timeline } = groupLiveToolEntries([
      assistant('assistant-batch', [
        { id: 'call-1', name: 'read' },
        { id: 'call-2', name: 'bash' },
      ]),
      result('call-1', 'read'),
      result('call-2', 'bash'),
      { type: 'message', message: { role: 'user', content: 'next' } },
    ])

    // The batch folds into one group; the later user turn stays visible.
    expect(timeline).toHaveLength(2)
    expect(timeline[0]?.type).toBe('toolGroup')
    if (timeline[0]?.type === 'toolGroup') expect(timeline[0].items).toHaveLength(2)
    expect(timeline[1]?.type).toBe('entry')
  })

  it('keeps the reply body of a message that issues several tool calls', () => {
    const { items } = groupLiveToolEntries([
      {
        type: 'message',
        id: 'assistant-batch',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看两处' },
            { type: 'text', text: '两处一起查' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a' } },
            { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'b' } },
          ],
        },
      },
      result('call-1', 'read'),
      result('call-2', 'bash'),
    ])

    // The calls still fold into one group, but the prose rides along as its own
    // entry instead of disappearing behind the group.
    expect(items.some(item => item.type === 'toolGroup')).toBe(true)
    const body = items.find(item => item.type === 'entry')
    expect(body).toBeTruthy()
    if (body?.type === 'entry') {
      const content = (body.entry as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []
      expect(content.some(part => part.type === 'text' && part.text === '两处一起查')).toBe(true)
      expect(content.some(part => part.type === 'toolCall')).toBe(false)
    }
  })
})

describe('groupLiveToolEntries compact reading', () => {
  it('drops thinking and tool/script rows while keeping the reply body', () => {
    const { items, hidden } = groupLiveToolEntries([
      assistant('assistant-1', [{ id: 'call-1', name: 'bash' }]),
      result('call-1', 'bash'),
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'the answer' }],
        },
      },
      { type: 'message', message: { role: 'user', content: 'what changed?' } },
    ], false)

    // Nothing is rendered as a tool row, and the pure-tool entries are gone.
    expect(items.every(item => item.type === 'entry')).toBe(true)
    expect(items).toHaveLength(2)
    expect(hidden.tools).toBe(2)      // one tool call + its result
    expect(hidden.thinking).toBe(1)   // the thinking part on the mixed message
  })

  it('also drops extension telemetry rows while reading', () => {
    const { items, hidden } = groupLiveToolEntries([
      { type: 'custom', customType: 'compact-thinking-duration', data: { ms: 12 } },
      { type: 'message', message: { role: 'user', content: 'only this should remain' } },
    ], false)
    expect(items).toHaveLength(1)
    expect(hidden.other).toBe(1)
  })

  it('keeps the auxiliary rows when reading in full', () => {
    const { items, hidden } = groupLiveToolEntries([
      assistant('assistant-1', [{ id: 'call-1', name: 'bash' }]),
      result('call-1', 'bash'),
    ])
    expect(hidden).toEqual({ tools: 0, thinking: 0, other: 0 })
    expect(items.length).toBeGreaterThan(0)
  })
})
