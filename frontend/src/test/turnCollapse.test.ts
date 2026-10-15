import { describe, it, expect } from 'vitest'
import { collapseOldTurns } from '../pages/chat/TurnCollapse'
import { groupToolMessages } from '../pages/chat/ToolGroup'
import type { ChatMessage } from '../types'

let seq = 0
function mk(role: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1
  return { role, content, ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`, ...extra } as ChatMessage
}

function tool(name: string): ChatMessage {
  return mk('tool', `🔧 ${name}`, { meta: { toolName: name, args: '{}' } as any })
}

function msg(role: string, content: string): ChatMessage {
  return mk(role, content)
}

function collapsed(items: ReturnType<typeof collapseOldTurns>['items']) {
  return items.filter(i => i.type === 'collapsed')
}

describe('collapseOldTurns', () => {
  it('keeps all turns open when there are no more than keepTurns', () => {
    const messages = [msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2'), msg('assistant', 'a2')]
    const { items } = collapseOldTurns(groupToolMessages(messages), { keepTurns: 3, expandedTurns: new Set() })
    expect(collapsed(items)).toHaveLength(0)
    expect(items).toHaveLength(4)
  })

  it('collapses older turns, keeping the user prompt and final reply', () => {
    const messages = [
      // Turn 1 (old): user + thinking + tools + interim reply + final reply
      msg('user', 'q1'),
      msg('thinking', 'think'),
      tool('read'), tool('bash'), tool('grep'),
      msg('assistant', 'interim'),
      tool('read'),
      msg('assistant', 'final-1'),
      // Turn 2 (recent): kept open
      msg('user', 'q2'),
      msg('assistant', 'final-2'),
    ]
    const { items } = collapseOldTurns(groupToolMessages(messages), { keepTurns: 1, expandedTurns: new Set() })

    const collapsedRows = collapsed(items)
    expect(collapsedRows).toHaveLength(1)
    expect(collapsedRows[0]).toMatchObject({ toolCount: 4, thinkingCount: 1, otherCount: 1 })

    // Turn 1 renders as: user prompt, collapsed row, final reply.
    const rendered = items.map(i => (i.type === 'collapsed' ? '[collapsed]' : i.type === 'single' ? i.message.content : '[group]'))
    expect(rendered).toEqual(['q1', '[collapsed]', 'final-1', 'q2', 'final-2'])
  })

  it('collapses turns without a final reply into user + summary row', () => {
    const messages = [
      msg('user', 'q1'),
      tool('bash'),
      // Turn 2 stays open
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ]
    const { items } = collapseOldTurns(groupToolMessages(messages), { keepTurns: 1, expandedTurns: new Set() })
    const rendered = items.map(i => (i.type === 'collapsed' ? '[collapsed]' : i.type === 'single' ? i.message.content : '[group]'))
    expect(rendered).toEqual(['q1', '[collapsed]', 'q2', 'a2'])
  })

  it('does not add a summary row when there is nothing hidden', () => {
    const messages = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ]
    const { items } = collapseOldTurns(groupToolMessages(messages), { keepTurns: 1, expandedTurns: new Set() })
    expect(collapsed(items)).toHaveLength(0)
  })

  it('renders an expanded turn in full', () => {
    const messages = [
      msg('user', 'q1'),
      tool('read'), tool('bash'), tool('grep'),
      msg('assistant', 'final-1'),
      msg('user', 'q2'),
      msg('assistant', 'final-2'),
    ]
    const grouped = groupToolMessages(messages)
    const first = collapseOldTurns(grouped, { keepTurns: 1, expandedTurns: new Set() })
    const row = collapsed(first.items)[0]
    expect(row).toBeTruthy()

    const expanded = collapseOldTurns(grouped, { keepTurns: 1, expandedTurns: new Set([row.turnKey]) })
    expect(collapsed(expanded.items)).toHaveLength(0)
    expect(expanded.items).toEqual(grouped)
  })

  it('maps every grouped message index to its turn key', () => {
    const messages = [
      msg('user', 'q1'),
      tool('read'), tool('bash'), tool('grep'), tool('edit'), // grouped (>2)
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ]
    const grouped = groupToolMessages(messages)
    const { turnKeyByIndex, collapsibleTurnKeys } = collapseOldTurns(grouped, { keepTurns: 1, expandedTurns: new Set() })
    // Every message index covered, and the old turn is flagged collapsible.
    expect(turnKeyByIndex.size).toBe(messages.length)
    expect(turnKeyByIndex.get(0)).toBe(turnKeyByIndex.get(5))
    expect(turnKeyByIndex.get(0)).not.toBe(turnKeyByIndex.get(6))
    expect(collapsibleTurnKeys.has(turnKeyByIndex.get(0)!)).toBe(true)
    expect(collapsibleTurnKeys.has(turnKeyByIndex.get(6)!)).toBe(false)
  })
})