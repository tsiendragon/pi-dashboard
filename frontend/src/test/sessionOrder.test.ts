import { describe, it, expect } from 'vitest'
import type { LiveSessionSummary } from '@shared/live-sessions'
import {
  anchorIndexOf, buildOrderIndex, buildSessionSections, materializeOrder, moveInOrder, resolveDropTarget, sortSessions,
} from '../features/live-sessions/sessionOrder'

function session(sessionId: string, startedAt: number, over: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId: `pid-${sessionId}`,
    sessionId,
    pid: startedAt,
    cwd: '/tmp/app',
    canonicalCwd: '/tmp/app',
    mode: 'tui',
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt,
    lastActivityAt: startedAt,
    revision: 1,
    eventSequence: 0,
    ...over,
  }
}

const ids = (items: LiveSessionSummary[]) => items.map(item => item.sessionId)

describe('buildSessionSections', () => {
  it('lays pinned first, then task groups, then ungrouped, honouring the manual order', () => {
    const groups = [{ id: 'g1', name: '任务A', sessionIds: ['b'], createdAt: '', updatedAt: '' }]
    const meta = { c: { tags: [], pinned: true, updatedAt: '' } }
    const sections = buildSessionSections([session('a', 1), session('b', 2), session('c', 3)], meta, groups, ['b', 'a'])
    expect(sections.map(section => section.name)).toEqual(['置顶', '任务A', '未分组'])
    expect(ids(sections[0].sessions)).toEqual(['c'])
    expect(ids(sections[1].sessions)).toEqual(['b'])
    expect(ids(sections[2].sessions)).toEqual(['a'])
  })

  it('drops empty blocks and never lists sub-agents as top-level rows', () => {
    const sections = buildSessionSections(
      [session('a', 1), session('child', 2, { parentSessionId: 'a' })],
      {}, [], [],
    )
    expect(sections.map(section => section.name)).toEqual(['未分组'])
    expect(ids(sections[0].sessions)).toEqual(['a'])
  })
})

describe('sortSessions', () => {
  it('follows the manual order before any automatic rule', () => {
    const rows = [session('a', 3), session('b', 2), session('c', 1)]
    expect(ids(sortSessions(rows, ['c', 'b', 'a']))).toEqual(['c', 'b', 'a'])
  })

  it('appends sessions the user never moved at the tail, oldest first', () => {
    const rows = [session('new-2', 90), session('a', 3), session('new-1', 80), session('b', 2)]
    // 'a' and 'b' were dragged; the two unseen sessions keep the legacy order.
    expect(ids(sortSessions(rows, ['b', 'a']))).toEqual(['b', 'a', 'new-1', 'new-2'])
  })

  it('ignores order entries for sessions that are no longer listed', () => {
    const rows = [session('a', 3), session('b', 2)]
    expect(ids(sortSessions(rows, ['gone', 'b', 'a']))).toEqual(['b', 'a'])
  })

  it('is deterministic when nothing is known about either row', () => {
    const rows = [session('a', 5), session('b', 5)]
    expect(ids(sortSessions(rows, []))).toEqual(ids(sortSessions([...rows].reverse(), [])))
  })
})

describe('buildOrderIndex / anchorIndexOf', () => {
  it('keeps the first occurrence of a duplicated id', () => {
    expect(buildOrderIndex(['a', 'b', 'a']).get('a')).toBe(0)
  })
  it('reports -1 for unknown rows', () => {
    expect(anchorIndexOf(['a', 'b'], 'c')).toBe(-1)
  })
})

describe('materializeOrder', () => {
  it('keeps on-screen rows in display order and pushes the rest to the tail', () => {
    expect(materializeOrder([], ['session-a', 'session-b'])).toEqual(['session-a', 'session-b'])
    expect(materializeOrder(['session-b', 'session-a', 'gone'], ['session-a', 'session-b']))
      .toEqual(['session-a', 'session-b', 'gone'])
  })

  it('lets a single-row move anchor against rows the user never dragged', () => {
    // Nothing stored, three rows on screen in startedAt order; moving the last
    // row one slot up must land between the first two, not at the very top.
    const base = materializeOrder([], ['session-a', 'session-b', 'session-c'])
    expect(moveInOrder(base, 'session-c', ['session-a', 'session-b'], 1)).toEqual(['session-a', 'session-c', 'session-b'])
  })
})

describe('moveInOrder', () => {
  const order = ['a', 'b', 'c', 'd']

  it('moves a row down inside its block without disturbing the others', () => {
    // block rows: a, c, d — move 'a' to the last slot of its block.
    // 'b' belongs to another block, so it keeps its slot in the flat list;
    // only the *display* order of the block has to change.
    expect(moveInOrder(order, 'a', ['c', 'd'], 2)).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(sortSessions(
      [session('a', 1), session('b', 2), session('c', 3), session('d', 4)].filter(row => row.sessionId !== 'b'),
      moveInOrder(order, 'a', ['c', 'd'], 2),
    ))).toEqual(['c', 'd', 'a'])
  })

  it('moves a row to the top of its block', () => {
    expect(moveInOrder(order, 'd', ['a', 'b', 'c'], 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('inserts between two anchors', () => {
    expect(moveInOrder(order, 'd', ['a', 'b', 'c'], 2)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('appends a row dropped into a block with no other anchors', () => {
    expect(moveInOrder(order, 'b', [], 0)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('adds a drag of a session that was never in the list', () => {
    expect(moveInOrder(order, 'new', ['a', 'b'], 1)).toEqual(['a', 'new', 'b', 'c', 'd'])
  })

  it('clamps an out-of-range index instead of dropping the row', () => {
    expect(moveInOrder(order, 'a', ['b', 'c', 'd'], 99)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveInOrder(order, 'a', ['b', 'c', 'd'], -5)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns the list unchanged for an empty session id', () => {
    expect(moveInOrder(order, '', ['a'], 0)).toEqual(order)
  })
})

describe('resolveDropTarget', () => {
  const rectOf = () => ({ top: 100, height: 20 })
  const anchorsOf = (sectionId: string) => (sectionId === 'g1' ? ['session-a', 'session-b'] : [])

  function row(sessionId: string, sectionId: string): Element {
    const el = document.createElement('div')
    el.setAttribute('data-live-row', sessionId)
    el.setAttribute('data-live-block', sectionId)
    return el
  }

  it('inserts before a row when the pointer is in its top half', () => {
    expect(resolveDropTarget(row('session-b', 'g1'), rectOf, 101, anchorsOf)).toEqual({ sectionId: 'g1', index: 1 })
  })

  it('inserts after a row when the pointer is in its bottom half', () => {
    expect(resolveDropTarget(row('session-a', 'g1'), rectOf, 119, anchorsOf)).toEqual({ sectionId: 'g1', index: 1 })
  })

  it('appends when the pointer lands on the block itself (header or tail)', () => {
    const block = document.createElement('section')
    block.setAttribute('data-live-block', 'g1')
    block.appendChild(row('session-a', 'g1'))
    expect(resolveDropTarget(block, rectOf, 400, anchorsOf)).toEqual({ sectionId: 'g1', index: 2 })
  })

  it('still resolves the block when the pointer is on a row inside it', () => {
    const block = document.createElement('section')
    block.setAttribute('data-live-block', 'g1')
    const child = row('session-a', 'g1')
    block.appendChild(child)
    expect(resolveDropTarget(child, rectOf, 100, anchorsOf)).toEqual({ sectionId: 'g1', index: 0 })
  })

  it('ignores the dragged row itself and anything outside a block', () => {
    const outside = document.createElement('div')
    expect(resolveDropTarget(outside, rectOf, 100, anchorsOf)).toBeUndefined()
    expect(resolveDropTarget(null, rectOf, 100, anchorsOf)).toBeUndefined()
    // 'session-c' is one of the anchors *excluding* the dragged row, so it has
    // no slot of its own — a drop there is meaningless and must be ignored.
    expect(resolveDropTarget(row('session-c', 'g1'), rectOf, 100, anchorsOf)).toBeUndefined()
  })
})