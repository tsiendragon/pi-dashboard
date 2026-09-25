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
  canvasFill,
  branchColorOf,
  defaultHeightOf,
  layoutCandidates,
  laneOf,
  pickBestLayout,
  serpentineLayout,
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

describe('serpentine layout', () => {
  it('wraps a chain into rows that each run the other way', () => {
    const layout = serpentineLayout(chain(7), defaultHeightOf, 3)
    const at = (id: string) => layout.positions.get(id)!
    // Row 0 left→right: n0 n1 n2
    expect(at('n0').x).toBe(0)
    expect(at('n1').x).toBe(NODE_W + 76)
    expect(at('n2').x).toBe((NODE_W + 76) * 2)
    // Row 1 right→left, so n3 (the next depth) starts at the SAME column n2 ended in:
    // the wrap edge is a short vertical hop, not a loop across the whole row.
    expect(at('n3').x).toBe(at('n2').x)
    expect(at('n3').y).toBeGreaterThan(at('n2').y)
    expect(at('n4').x).toBe(at('n1').x)
    // Row 2 runs left→right again: n6 sits under n5 and under n0's column.
    expect(at('n6').x).toBe(0)
    expect(at('n6').y).toBeGreaterThan(at('n3').y)
  })

  it('keeps every consecutive pair adjacent (3 rows of 3 for 9 nodes)', () => {
    const layout = serpentineLayout(chain(9), defaultHeightOf, 3)
    const at = (id: string) => layout.positions.get(id)!
    for (let index = 0; index < 8; index += 1) {
      const from = at(`n${index}`)
      const to = at(`n${index + 1}`)
      if (from.y === to.y) {
        // Same row: the next step is the horizontal neighbour.
        expect(Math.abs(from.x - to.x)).toBe(NODE_W + 76)
      } else {
        // Row wrap: the next step is directly below in the SAME column, which is
        // exactly why no curved “return” edge is needed.
        expect(from.x).toBe(to.x)
        expect(to.y).toBeGreaterThan(from.y)
      }
    }
    expect(layout.width).toBe((NODE_W + 76) * 3 - 76)
  })

  it('centres a parent on its children inside its row band', () => {
    const nodes = [
      node('root', null, { childCount: 2 }),
      node('left', 'root', { childCount: 1 }),
      node('right', 'root', { isLeaf: true }),
      node('tail', 'left', { isLeaf: true, isHead: true }),
    ]
    const layout = serpentineLayout(nodes, defaultHeightOf, 2)
    const root = layout.positions.get('root')!
    const left = layout.positions.get('left')!
    const right = layout.positions.get('right')!
    // Both children share depth 1, so they stack in one column and the parent sits
    // between them.
    expect(left.x).toBe(right.x)
    expect(root.y).toBeGreaterThan(left.y)
    expect(root.y).toBeLessThan(right.y)
  })

  it('gives a tall expanded card its own band height', () => {
    const nodes = [
      node('a', null, { childCount: 1 }),
      node('b', 'a', { kind: 'collapsed', expanded: true, childCount: 1 }),
      node('c', 'b', { isLeaf: true, isHead: true }),
    ]
    const layout = serpentineLayout(nodes, defaultHeightOf, 2)
    expect(layout.positions.get('c')!.y).toBeGreaterThanOrEqual(NODE_H_EXPANDED + GAP_Y)
  })
})

describe('automatic layout choice', () => {
  const pick = (nodes: ReturnType<typeof chain>, width: number, height: number) =>
    pickBestLayout(layoutCandidates(nodes, defaultHeightOf, width, height))

  it('wraps a long chain into rows on a wide desktop instead of leaving it a thin line', () => {
    const chosen = pick(chain(12), 1400, 800)
    expect(chosen.orientation).toBe('serpentine')
    expect(chosen.columns).toBeGreaterThanOrEqual(3)
  })

  it('turns the same chain top→down on a portrait phone', () => {
    expect(pick(chain(12), 390, 700).orientation).toBe('vertical')
  })

  it('lays a shallow wide tree out as one wide row (depth on y matches a wide canvas)', () => {
    // Root with 8 leaves. “vertical” here means depth→y, so the 8 leaves become one
    // wide row — which is what a 2600x700 canvas wants; the classic left→right tree
    // would instead be 500x564 and waste the width.
    const nodes = [node('root', null, { childCount: 8 })]
    for (let index = 0; index < 8; index += 1) nodes.push(node(`leaf${index}`, 'root', { isLeaf: true }))
    expect(pick(nodes, 2600, 700).orientation).toBe('vertical')
  })

  it('scores fill by aspect-ratio match', () => {
    const wide = tidyLayout(chain(4), defaultHeightOf, 'horizontal')
    const square = tidyLayout(chain(4), defaultHeightOf, 'vertical')
    expect(canvasFill(wide, 2600, 400)).toBeGreaterThan(canvasFill(square, 2600, 400))
    expect(canvasFill(square, 400, 2600)).toBeGreaterThan(canvasFill(wide, 400, 2600))
  })

  it('has no opinion before the container is measured', () => {
    expect(pickBestLayout(layoutCandidates(chain(4), defaultHeightOf, 0, 0)).orientation).toBe('horizontal')
  })
})

/**
 * Regression: a long single-file session in “逐条记录” is ONE CHAIN of thousands of
 * nodes. The old recursive DFS blew the JS stack — the graph route showed an
 * app-wide “Maximum call stack size exceeded” error page — so the walk is
 * iterative now and must lay such a chain out normally.
 */
describe('long linear sessions', () => {
  it('lays out a 6000-deep chain instead of overflowing the stack', () => {
    const size = 6000
    const nodes = chain(size)
    const layout = tidyLayout(nodes)
    expect(layout.positions.size).toBe(size)
    expect(layout.positions.get(`n${size - 1}`)!.x).toBeGreaterThan(layout.positions.get('n0')!.x)
  })
})

/**
 * Fork colours. The graph has no group boxes any more, so the colour of an edge and
 * of a card outline is what tells a reader which fork lineage a card belongs to.
 */
describe('branchColorOf', () => {
  it('keeps one colour along a plain chain', () => {
    const colors = branchColorOf(chain(5))
    expect(new Set(colors.values()).size).toBe(1)
  })

  it('gives every child of a fork a different colour, none of them the parent colour', () => {
    const colors = branchColorOf([
      node('a', null, { childCount: 2 }),
      node('b', 'a', { isLeaf: true }),
      node('c', 'a', { isLeaf: true }),
    ])
    const kids = ['b', 'c'].map(id => colors.get(id))
    expect(new Set(kids).size).toBe(2)
    expect(kids).not.toContain(colors.get('a'))
  })

  it('reuses the palette for a fork wider than the palette', () => {
    // Pigeonhole: parent + 4 children cannot all differ with 3 slots. The one thing
    // that must hold is that the siblings still do not all collapse into one colour.
    const colors = branchColorOf([
      node('a', null, { childCount: 4 }),
      ...['b', 'c', 'd', 'e'].map(id => node(id, 'a', { isLeaf: true })),
    ])
    expect(new Set(['b', 'c', 'd', 'e'].map(id => colors.get(id))).size).toBeGreaterThan(1)
  })

  it('lets a plain chain keep its colour and re-forks further down', () => {
    const colors = branchColorOf([
      node('a', null, { childCount: 1 }),
      node('b', 'a', { childCount: 2 }),
      node('d', 'b', { isLeaf: true }),
      node('e', 'b', { isLeaf: true }),
    ])
    // a→b is a single child, so it inherits; the fork at b then hands out new colours.
    expect(colors.get('b')).toBe(colors.get('a'))
    expect(colors.get('d')).not.toBe(colors.get('e'))
    expect(colors.get('d')).not.toBe(colors.get('b'))
  })

  it('colours every node and survives a 6000-deep chain', () => {
    const nodes = chain(6000)
    const colors = branchColorOf(nodes)
    expect(colors.size).toBe(6000)
    expect(new Set(colors.values()).size).toBe(1)
  })

  it('does not hang on a parentId cycle', () => {
    const colors = branchColorOf([node('a', 'b'), node('b', 'a')])
    expect(colors.size).toBe(2)
  })
})

/**
 * Lanes: “which branch line is this node on”. The layout needs the same grouping the
 * colours use, so it can refuse a shape in which two branches share a line.
 */
describe('laneOf', () => {
  it('keeps a chain in one lane', () => {
    expect(new Set(laneOf(chain(6)).values()).size).toBe(1)
  })

  it('opens one lane per child of a fork and per root', () => {
    const lanes = laneOf([
      node('t', null, { childCount: 1 }),
      node('fork', 't', { childCount: 2 }),
      node('left', 'fork', { isLeaf: true }),
      node('right', 'fork', { isLeaf: true }),
    ])
    expect(lanes.get('t')).toBe(lanes.get('fork'))
    expect(lanes.get('left')).not.toBe(lanes.get('right'))
    expect(lanes.get('left')).not.toBe(lanes.get('fork'))
    const twoRoots = laneOf([node('r1', null), node('r2', null)])
    expect(twoRoots.get('r1')).not.toBe(twoRoots.get('r2'))
  })
})

/**
 * Branch-aware shape choice.
 *
 * Regression (real graph, 4 session files): the trunk forked into three two-node
 * branches, and `serpentine×3` — which only folds the depth axis — placed all six
 * cards in ONE column at x=576 (y = 0, 72, 144, 216, 288, 360) because its fill score
 * (0.69) beat the tidy shapes. Every branch's edge then ran vertically through the
 * other branches' cards, and the graph read as one long path.
 */
describe('branch-aware layout choice', () => {
  /** Trunk → fork → three branches of two nodes, mirroring the reported shape. */
  const forked = (): SessionTreeNode[] => [
    node('trunk', null, { childCount: 1 }),
    node('fork', 'trunk', { childCount: 3 }),
    node('b1', 'fork', { childCount: 1 }),
    node('b1h', 'b1', { isLeaf: true, isHead: true }),
    node('b2', 'fork', { childCount: 1 }),
    node('b2h', 'b2', { isLeaf: true, isHead: true }),
    node('b3', 'fork', { childCount: 1 }),
    node('b3h', 'b3', { isLeaf: true, isHead: true }),
  ]

  it('prices the wrap down when it would mix several branches into one row band', () => {
    const candidates = layoutCandidates(forked(), defaultHeightOf, 1680, 900)
    const wraps = candidates.filter(candidate => candidate.orientation === 'serpentine')
    expect(wraps.length).toBeGreaterThan(0)
    for (const wrap of wraps) expect(wrap.cohesion).toBeLessThan(1)
    expect(pickBestLayout(candidates).orientation).not.toBe('serpentine')
  })

  it('keeps a plain chain wrapable (that is what the wrap exists for)', () => {
    const wraps = layoutCandidates(chain(12), defaultHeightOf, 1200, 1400)
      .filter(candidate => candidate.orientation === 'serpentine')
    expect(wraps.length).toBeGreaterThan(0)
    for (const wrap of wraps) expect(wrap.cohesion).toBe(1)
  })

  it('gives each fork branch its own line, with its continuations on it', () => {
    const nodes = forked()
    const picked = pickBestLayout(layoutCandidates(nodes, defaultHeightOf, 1680, 900))
    const lanes = laneOf(nodes)
    // Vertical grows depth→y, so a “line” is a column; horizontal grows depth→x.
    const lineOf = (id: string): number => {
      const position = picked.layout.positions.get(id)
      if (!position) throw new Error(`no position for ${id}`)
      return picked.orientation === 'vertical' ? position.x : position.y
    }
    // The three siblings must not sit on one line…
    expect(new Set(['b1', 'b2', 'b3'].map(lineOf)).size).toBe(3)
    // …and each one keeps its own head on that same line.
    const linesPerLane = new Map<number, Set<number>>()
    for (const node of nodes) {
      const lane = lanes.get(node.id) as number
      const lines = linesPerLane.get(lane) ?? new Set<number>()
      lines.add(lineOf(node.id))
      linesPerLane.set(lane, lines)
    }
    for (const lines of linesPerLane.values()) expect(lines.size).toBe(1)
  })
})