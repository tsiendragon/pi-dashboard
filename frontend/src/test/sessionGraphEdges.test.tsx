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
import SessionFamilyGraph from '../features/live-sessions/graph/SessionFamilyGraph'

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

  it('routes a serpentine wrap as a downward arrow (same column)', () => {
    // A 12-node chain on a wide canvas wraps into rows; the wrap edge must turn
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