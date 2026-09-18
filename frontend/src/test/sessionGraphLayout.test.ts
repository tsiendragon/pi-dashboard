/**
 * Layout tests for the session-family graph.
 *
 * The interesting case is the expanded folded run: it is ONE graph node but a much
 * taller card, so the layout has to reserve its height or it would overlap the
 * neighbouring rows.
 */
import { describe, expect, it } from 'vitest'
import type { SessionTreeNode } from '@shared/session-tree'
import {
  NODE_H,
  NODE_H_EXPANDED,
  NODE_W,
  defaultHeightOf,
  sessionBounds,
  tidyLayout,
} from '../features/live-sessions/graph/layout'

function node(id: string, parentId: string | null, overrides: Partial<SessionTreeNode> = {}): SessionTreeNode {
  return {
    id,
    parentId,
    kind: 'message',
    sessionKey: 's',
    type: 'message',
    title: id,
    childCount: 0,
    isLeaf: false,
    isHead: false,
    ...overrides,
  }
}

describe('defaultHeightOf', () => {
  it('gives an expanded folded run the tall card height', () => {
    expect(defaultHeightOf(node('a', null))).toBe(NODE_H)
    expect(defaultHeightOf(node('b', 'a', { kind: 'collapsed', expanded: true }))).toBe(NODE_H_EXPANDED)
  })
})

describe('tidyLayout', () => {
  it('lays a linear chain out along one row, one depth per node', () => {
    const nodes = [node('a', null, { childCount: 1 }), node('b', 'a', { childCount: 1 }), node('c', 'b', { isLeaf: true, isHead: true })]
    const layout = tidyLayout(nodes)
    // A chain shares one leaf row, so depth is expressed on x only.
    expect(layout.positions.get('a')).toEqual({ x: 0, y: 0 })
    expect(layout.positions.get('b')).toEqual({ x: NODE_W + 76, y: 0 })
    expect(layout.positions.get('c')).toEqual({ x: (NODE_W + 76) * 2, y: 0 })
    expect(layout.width).toBe((NODE_W + 76) * 2 + NODE_W)
    expect(layout.height).toBe(NODE_H)
  })

  it('reserves the tall card height so stacked nodes in one column never overlap', () => {
    // Two nodes share the same depth column (a branch), the first one expanded.
    const nodes = [
      node('root', null, { childCount: 2 }),
      node('expanded', 'root', { kind: 'collapsed', expanded: true, childCount: 1 }),
      node('plain', 'root', { isLeaf: true }),
      node('tail', 'expanded', { isLeaf: true, isHead: true }),
    ]
    const layout = tidyLayout(nodes)
    const expanded = layout.positions.get('expanded')
    const plain = layout.positions.get('plain')
    expect(expanded?.x).toBe(plain?.x)
    expect(plain?.y ?? 0).toBeGreaterThanOrEqual((expanded?.y ?? 0) + NODE_H_EXPANDED)
    // The canvas grows to fit the tall card.
    expect(layout.height).toBeGreaterThanOrEqual((expanded?.y ?? 0) + NODE_H_EXPANDED)
  })

  it('lays out orphans as extra roots instead of dropping them', () => {
    const nodes = [node('a', null, { isLeaf: true }), node('orphan', 'missing-parent', { isLeaf: true })]
    const layout = tidyLayout(nodes)
    expect(layout.positions.size).toBe(2)
  })
})

describe('sessionBounds', () => {
  it('includes the expanded card height in the group band', () => {
    const nodes = [
      node('a', null, { childCount: 1 }),
      node('b', 'a', { kind: 'collapsed', expanded: true, isLeaf: true, isHead: true }),
    ]
    const layout = tidyLayout(nodes)
    const bounds = sessionBounds(nodes, layout.positions, 's')
    expect(bounds).not.toBeNull()
    expect(bounds?.height ?? 0).toBeGreaterThan(NODE_H_EXPANDED)
  })
})