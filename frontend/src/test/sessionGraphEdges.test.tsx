/**
 * Edge rendering tests for the session-family graph.
 *
 * The graph is a picture of a conversation's history, so an edge that only says
 * "connected" is not enough — the reader has to see WHICH WAY the steps run. These
 * tests pin that down: every edge carries an arrowhead whose tip lands just before
 * the child card, and the focus branch keeps the accent-coloured arrow.
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { SessionNodeKind, SessionTreeGraph, SessionTreeNode } from '@shared/session-tree'
import SessionFamilyGraph, { estimateTextWidth } from '../features/live-sessions/graph/SessionFamilyGraph'

function node(id: string, parentId: string | null, overrides: Partial<SessionTreeNode> = {}): SessionTreeNode {
  return {
    id,
    parentId,
    kind: 'message' as SessionNodeKind,
    sessionKey: 's',
    type: 'message',
    title: id,
    childCount: 0,
    isLeaf: false,
    isHead: false,
    ...overrides,
  }
}

function graph(nodes: SessionTreeNode[]): SessionTreeGraph {
  return {
    focusKey: 's',
    sessions: [{ key: 's', file: '/tmp/s.jsonl', sessionId: 's', entryCount: nodes.length, leafId: 'c', isFocus: true, isLive: true }],
    nodes,
    detail: 'collapsed',
    truncated: false,
    generatedAt: 0,
  }
}

function renderGraph(nodes: SessionTreeNode[], selectedId: string | null = null) {
  return render(
    <SessionFamilyGraph
      graph={graph(nodes)}
      selectedId={selectedId}
      onSelect={vi.fn()}
      onOpenSession={vi.fn()}
      onToggleExpand={vi.fn()}
      onLoadMore={vi.fn()}
    />,
  )
}

/** `a → b → c`, the default (folded) shape of a linear conversation. */
const chain = [
  node('a', null, { childCount: 1 }),
  node('b', 'a', { childCount: 1 }),
  node('c', 'b', { isLeaf: true, isHead: true }),
]

describe('graph edges', () => {
  it('defines both arrowheads (focus branch and muted)', () => {
    const { container } = renderGraph(chain)
    expect(container.querySelector('marker#ls-graph-arrow')).not.toBeNull()
    expect(container.querySelector('marker#ls-graph-arrow-active')).not.toBeNull()
    // `orient="auto"` is what makes the arrow follow the curve's direction.
    expect(container.querySelector('marker#ls-graph-arrow')?.getAttribute('orient')).toBe('auto')
  })

  it('puts an arrowhead on every edge', () => {
    const { container } = renderGraph(chain)
    const edges = [...container.querySelectorAll('path[marker-end]')]
    expect(edges).toHaveLength(2)
    for (const edge of edges) {
      expect(edge.getAttribute('marker-end')).toMatch(/^url\(#ls-graph-arrow(-active)?\)$/)
    }
  })

  it('colours the arrow of the focus branch with accent and the others muted', () => {
    const { container } = renderGraph(chain)
    const active = container.querySelector('path[marker-end="url(#ls-graph-arrow-active)"]')
    const muted = container.querySelector('path[marker-end="url(#ls-graph-arrow)"]')
    // a→b→c is entirely on the active branch, so both a→b and b→c are accent…
    const all = [...container.querySelectorAll('path[marker-end]')]
    expect(all.every(edge => edge.getAttribute('marker-end') === 'url(#ls-graph-arrow-active)')).toBe(true)
    expect(active).not.toBeNull()
    expect(muted).toBeNull()
  })

  it('draws a side branch as a muted arrow while the trunk stays accent', () => {
    const { container } = renderGraph([
      node('a', null, { childCount: 2 }),
      node('b', 'a', { childCount: 1 }),
      node('c', 'b', { isLeaf: true, isHead: true }),
      node('side', 'a', { isLeaf: true }),
    ])
    const markers = [...container.querySelectorAll('path[marker-end]')].map(edge => edge.getAttribute('marker-end'))
    expect(markers).toContain('url(#ls-graph-arrow-active)')
    expect(markers).toContain('url(#ls-graph-arrow)')
  })

  it('anchors each arrow on the child card, not on the parent', () => {
    const { container } = renderGraph(chain)
    const cardOf = (id: string) => {
      const rect = container.querySelector(`[data-node-id="${id}"] rect`)
      if (!rect) throw new Error(`no card for ${id}`)
      const x = Number(rect.getAttribute('x'))
      const y = Number(rect.getAttribute('y'))
      return { x, y, width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) }
    }
    /** Distance from a point to the card's border (0 = exactly on it, <0 = inside). */
    const clearance = (point: [number, number], card: ReturnType<typeof cardOf>): number => {
      const insideX = point[0] - card.x
      const insideY = point[1] - card.y
      const distances = [insideX, card.width - insideX, insideY, card.height - insideY]
      // Bounding boxes overlap for cards on different rows, so also require the point
      // to be within the card's span on at least one axis.
      return Math.min(...distances)
    }
    for (const [parentId, childId] of [['a', 'b'], ['b', 'c']] as const) {
      const edge = container.querySelector(`[data-node-id="${childId}"]`)?.parentElement
        ?.parentElement?.querySelector(`path[marker-end]`) ?? null
      // Fall back to scanning: the edge group is keyed by the child id.
      const paths = [...container.querySelectorAll('path[marker-end]')]
      const match = paths.find(path => {
        const numbers = (path.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
        const end: [number, number] = [numbers[numbers.length - 2], numbers[numbers.length - 1]]
        const parent = cardOf(parentId)
        const child = cardOf(childId)
        // The end sits on the child's border and the start on the parent's border.
        const start: [number, number] = [numbers[0], numbers[1]]
        return Math.abs(clearance(end, child)) < 1.5 && Math.abs(clearance(start, parent)) < 1.5
      })
      expect(match ?? edge).not.toBeNull()
      expect(match).toBeTruthy()
    }
  })

  it('routes a serpentine wrap as a downward arrow (same column)', () => {    // A 12-node chain on a wide canvas wraps into rows; the wrap edge must turn
    // downward instead of looping back across the row.
    const long = Array.from({ length: 12 }, (_, index) => node(
      `n${index}`,
      index === 0 ? null : `n${index - 1}`,
      index === 11 ? { isLeaf: true, isHead: true } : { childCount: 1 },
    ))
    const { container } = renderGraph(long)
    const vertical = [...container.querySelectorAll('path[marker-end]')].filter(edge => {
      const numbers = (edge.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
      const ax = numbers[0]
      const ay = numbers[1]
      const bx = numbers[numbers.length - 2]
      const by = numbers[numbers.length - 1]
      return Math.abs(bx - ax) < 1 && by > ay
    })
    expect(vertical.length).toBeGreaterThan(0)
  })
})

describe('group band labels', () => {
  it('draws them above the cards so an overlapping band cannot bury them', () => {
    const { container } = renderGraph(chain)
    const cards = [...container.querySelectorAll('[data-node-id]')]
    const label = [...container.querySelectorAll('text')].find(text => text.textContent?.includes('· 当前'))
    expect(cards.length).toBeGreaterThan(0)
    expect(label).toBeTruthy()
    // The label must come after the last card in document order (SVG has no z-index).
    const order = [...container.querySelectorAll('*')]
    expect(order.indexOf(label!)).toBeGreaterThan(order.indexOf(cards[cards.length - 1]))
  })

  it('haloes the label text so it stays readable over a card', () => {
    const { container } = renderGraph(chain)
    const label = [...container.querySelectorAll('text')].find(text => text.textContent?.includes('· 当前'))
    expect(label?.getAttribute('paint-order')).toBe('stroke')
    expect(label?.getAttribute('stroke')).toBe('var(--bg)')
  })
})

const LONG_KEY = '2026-09-20T05-56-41-769Z_01a0ae48-0c5a-7055-9cb7-45cd56f8c7db'

describe('band label vs entry count', () => {
  /** Session `s` is a long chain (wide band); the child is one card (narrow band). */
  function twoBands() {
    const nodes = chain.map(item => ({ ...item, sessionKey: LONG_KEY }))
    nodes.push(node('childOnly', null, { sessionKey: `${LONG_KEY}_child`, isLeaf: true, isHead: true }))
    const graph: SessionTreeGraph = {
      focusKey: LONG_KEY,
      sessions: [
        { key: LONG_KEY, file: '/tmp/a.jsonl', sessionId: 'a', entryCount: 1675, leafId: 'c', isFocus: true, isLive: true },
        { key: `${LONG_KEY}_child`, file: '/tmp/b.jsonl', sessionId: 'b', entryCount: 1986, leafId: 'x', isFocus: false, isLive: true, forkOf: LONG_KEY },
      ],
      nodes,
      detail: 'collapsed',
      truncated: false,
      generatedAt: 0,
    }
    return render(
      <SessionFamilyGraph
        graph={graph}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenSession={vi.fn()}
        onToggleExpand={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    )
  }

  it('never prints a name wider than the room left by the count', () => {
    const { container } = twoBands()
    const bandWidths = [...container.querySelectorAll('rect[data-band]')]
      .map(rect => Number(rect.getAttribute('width')))
      .sort((a, b) => a - b)
    // Text nodes only: the <title> tooltip holds the full key and would inflate this.
    const ownText = (element: Element): string => [...element.childNodes]
      .filter(child => child.nodeType === 3)
      .map(child => child.textContent ?? '')
      .join('')
    const labelWidths = [...container.querySelectorAll('text')]
      .map(ownText)
      .filter(text => text.includes('01a0ae48'))
      .map(estimateTextWidth)
      .sort((a, b) => a - b)
    expect(bandWidths).toHaveLength(2)
    expect(labelWidths).toHaveLength(2)
    // The narrow band gets the shorter name: name + count can never collide.
    expect(labelWidths[0]).toBeLessThan(labelWidths[1])
    for (const [index, bandWidth] of bandWidths.entries()) {
      // 12px padding on each side + 12px between the two texts
      expect(labelWidths[index] + estimateTextWidth('1986 条 · 运行中') + 36).toBeLessThanOrEqual(bandWidth)
    }
  })
})

describe('edge badges', () => {
  const shape = [
    node('start', null, { childCount: 1 }),
    node('head', 'start', { isLeaf: true, isHead: true }),
  ]

  function renderWithBadges(badges?: Record<string, number>) {
    return render(
      <SessionFamilyGraph
        graph={graph(shape)}
        selectedId={null}
        onSelect={vi.fn()}
        onOpenSession={vi.fn()}
        onToggleExpand={vi.fn()}
        onLoadMore={vi.fn()}
        edgeBadges={badges}
      />,
    )
  }

  it('sizes the pill to its text so it fits between two cards', () => {
    const { container } = renderWithBadges({ head: 1673 })
    const badge = container.querySelector('[data-badge]')
    expect(badge?.textContent).toBe('+1673 轮')
    const width = Number(badge?.querySelector('rect')?.getAttribute('width'))
    // Fits the 76px column gutter with room to spare.
    expect(width).toBeLessThan(76)
    expect(width).toBeGreaterThan(30)
  })

  it('asks the layout for taller rows so a badge has somewhere to sit', () => {
    const cardY = (container: HTMLElement, id: string) =>
      Number(container.querySelector(`[data-node-id="${id}"] rect[rx="10"]`)?.getAttribute('y'))
    const without = cardY(renderWithBadges().container, 'head')
    const withBadge = cardY(renderWithBadges({ head: 1673 }).container, 'head')
    // These two cards are stacked (vertical layout), so the row gap shows up as their
    // y distance — a 12px gap leaves a 16px pill nowhere to go.
    expect(withBadge - without).toBeGreaterThanOrEqual(20)
  })
})