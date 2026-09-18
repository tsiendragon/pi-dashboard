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
  GAP_Y,
  NODE_H,
  NODE_H_EXPANDED,
  NODE_W,
  chooseOrientation,
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

/** A linear chain of `size` nodes, ids n0..n{size-1}, last one being the head. */
function chain(size: number): SessionTreeNode[] {
  return Array.from({ length: size }, (_, index) => node(
    `n${index}`,
    index === 0 ? null : `n${index - 1}`,
    index === size - 1 ? { isLeaf: true, isHead: true } : { childCount: 1 },
  ))
}

describe('vertical orientation', () => {
  it('grows depth downward and keeps a chain in one column', () => {
    const layout = tidyLayout(chain(3), defaultHeightOf, 'vertical')
    expect(layout.positions.get('n0')).toEqual({ x: 0, y: 0 })
    expect(layout.positions.get('n1')).toEqual({ x: 0, y: NODE_H + GAP_Y })
    expect(layout.positions.get('n2')).toEqual({ x: 0, y: (NODE_H + GAP_Y) * 2 })
    expect(layout.width).toBe(NODE_W)
    expect(layout.height).toBe((NODE_H + GAP_Y) * 2 + NODE_H)
  })

  it('grows a depth level by the tallest card in it', () => {
    // n1..n3 sit in the same depth level in this shape; make one of them expanded.
    const nodes = [
      node('root', null, { childCount: 3 }),
      node('expanded', 'root', { kind: 'collapsed', expanded: true, childCount: 1 }),
      node('plain', 'root', { isLeaf: true }),
      node('tail', 'expanded', { isLeaf: true, isHead: true }),
    ]
    const layout = tidyLayout(nodes, defaultHeightOf, 'vertical')
    const levelOne = layout.positions.get('expanded')?.y ?? 0
    const levelTwo = layout.positions.get('tail')?.y ?? 0
    expect(levelTwo).toBeGreaterThanOrEqual(levelOne + NODE_H_EXPANDED + GAP_Y)
    // Siblings in the same level sit side by side instead of overlapping.
    expect(layout.positions.get('plain')?.x).toBeGreaterThan(layout.positions.get('expanded')?.x ?? 0)
  })
})

describe('chooseOrientation', () => {
  const horizontal = tidyLayout(chain(5), defaultHeightOf, 'horizontal')
  const vertical = tidyLayout(chain(5), defaultHeightOf, 'vertical')

  it('turns a long chain vertical on a portrait phone (it renders far bigger)', () => {
    expect(chooseOrientation(horizontal, vertical, 390, 700)).toBe('vertical')
  })

  it('keeps the familiar left-to-right reading on a wide desktop when scores are close', () => {
    expect(chooseOrientation(horizontal, vertical, 1400, 800)).toBe('horizontal')
  })

  it('turns even a desktop-wide chain vertical once horizontal would shrink too much', () => {
    const longHorizontal = tidyLayout(chain(20), defaultHeightOf, 'horizontal')
    const longVertical = tidyLayout(chain(20), defaultHeightOf, 'vertical')
    expect(chooseOrientation(longHorizontal, longVertical, 1600, 900)).toBe('vertical')
  })

  it('has no opinion before the container is measured', () => {
    expect(chooseOrientation(horizontal, vertical, 0, 0)).toBe('horizontal')
  })
})