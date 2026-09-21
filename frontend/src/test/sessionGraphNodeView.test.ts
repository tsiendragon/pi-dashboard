/**
 * 骨架视图 (structure-only) tests.
 *
 * 97% of real sessions never fork, and even a forked family is mostly a straight
 * line. So the default view keeps only the nodes that carry SHAPE (roots, session
 * starts, branch points, fork anchors, the current head, labelled nodes) and moves
 * the step count of everything it drops onto the edge that jumps over it.
 */
import { describe, expect, it } from 'vitest'
import type { SessionNodeKind, SessionTreeNode, SessionTreeSessionEntry } from '@shared/session-tree'
import { applyNodeView, isLinearFamily, reduceToStructure } from '../features/live-sessions/graph/nodeView'

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

const session = (key: string, overrides: Partial<SessionTreeSessionEntry> = {}): SessionTreeSessionEntry => ({
  key, file: `/tmp/${key}.jsonl`, sessionId: key, entryCount: 1, leafId: null, isFocus: key === 's', ...overrides,
})

/** A real default shape: start → +418 步 → Compaction → +868 步 → HEAD. */
const realShape = [
  node('start', null, { childCount: 1, title: 'Model → deepseek' }),
  node('run:h1', 'start', { kind: 'collapsed' as SessionNodeKind, collapsedCount: 418, childCount: 1 }),
  node('compaction', 'run:h1', { type: 'compaction', childCount: 1 }),
  node('run:h2', 'compaction', { kind: 'collapsed' as SessionNodeKind, collapsedCount: 868, childCount: 1 }),
  node('head', 'run:h2', { isLeaf: true, isHead: true }),
]

describe('isLinearFamily', () => {
  it('accepts a single file with no branching', () => {
    expect(isLinearFamily(realShape, [session('s')])).toBe(true)
  })

  it('rejects a node with several children', () => {
    const forked = [...realShape]
    forked[1] = { ...forked[1], childCount: 2 }
    expect(isLinearFamily(forked, [session('s')])).toBe(false)
  })

  it('rejects a family with more than one session file', () => {
    expect(isLinearFamily(realShape, [session('s'), session('child')])).toBe(false)
  })
})

describe('reduceToStructure', () => {
  it('keeps only the start and the current head for a straight line', () => {
    const { nodes } = reduceToStructure(realShape, [session('s')])
    expect(nodes.map(node => node.id)).toEqual(['start', 'head'])
  })

  it('re-parents the head onto the start and recounts children', () => {
    const { nodes } = reduceToStructure(realShape, [session('s')])
    expect(nodes[0]).toMatchObject({ id: 'start', parentId: null, childCount: 1, isLeaf: false })
    expect(nodes[1]).toMatchObject({ id: 'head', parentId: 'start', childCount: 0, isLeaf: true, isHead: true })
  })

  it('moves the hidden steps onto the edge that jumps over them', () => {
    const view = reduceToStructure(realShape, [session('s')])
    // 418 (folded run) + 1 (compaction) + 868 (folded run)
    expect(view.badges).toEqual({ head: 1287 })
    expect(view.hiddenSteps).toBe(1287)
  })

  it('keeps branch points, the fork anchor and each session start', () => {
    // s: start → anchor(branch) → [a1 → head], and a child file forked at `anchor`.
    const forked = [
      node('start', null, { childCount: 1 }),
      node('anchor', 'start', { childCount: 2 }),
      node('a1', 'anchor', { childCount: 1 }),
      node('head', 'a1', { isLeaf: true, isHead: true }),
      node('mid', 'anchor', { childCount: 1 }),
      node('childStart', 'mid', { sessionKey: 'child', childCount: 1 }),
      node('childRun', 'childStart', { sessionKey: 'child', kind: 'collapsed' as SessionNodeKind, collapsedCount: 40, childCount: 1 }),
      node('childHead', 'childRun', { sessionKey: 'child', isLeaf: true, isHead: true }),
    ]
    const view = reduceToStructure(forked, [session('s'), session('child', { forkAnchorId: 'anchor' })])
    const kept = view.nodes.map(node => node.id)
    expect(kept).toContain('start')
    expect(kept).toContain('anchor')
    expect(kept).toContain('head')
    expect(kept).toContain('childStart')
    expect(kept).toContain('childHead')
    // 中间那条 `mid` 被折叠，步数记在它后面的第一条保留边上，而不是凭空变出一条边。
    expect(view.badges.childStart).toBe(1)
    expect(view.nodes.find(node => node.id === 'childHead')?.parentId).toBe('childStart')
    expect(view.badges.childHead).toBe(40)
  })

  it('never invents an edge across a branch', () => {
    const branch = [
      node('root', null, { childCount: 2 }),
      node('left', 'root', { childCount: 1 }),
      node('leftTail', 'left', { isLeaf: true, isHead: true }),
      node('right', 'root', { childCount: 1 }),
      node('rightTail', 'right', { isLeaf: true }),
    ]
    const { nodes } = reduceToStructure(branch, [session('s')])
    const byId = new Map(nodes.map(node => [node.id, node]))
    // Both tails keep their own parent chain; they are not chained to each other.
    expect(byId.get('leftTail')?.parentId).toBe('root')
    expect(byId.get('rightTail')?.parentId).toBe('root')
  })

  it('keeps a labelled node', () => {
    const labelled = [...realShape]
    labelled[2] = { ...labelled[2], label: '重要' }
    expect(reduceToStructure(labelled, [session('s')]).nodes.map(node => node.id)).toContain('compaction')
  })

  it('leaves a two-node family untouched (nothing to hide)', () => {
    const two = [realShape[0], realShape[4]]
    const view = reduceToStructure(two, [session('s')])
    expect(view.nodes).toBe(two)
    expect(view.hiddenSteps).toBe(0)
  })

  it('does nothing when there is only one node', () => {
    const single = [node('only', null, { isLeaf: true, isHead: true })]
    expect(reduceToStructure(single, [session('s')]).nodes).toBe(single)
  })
})

describe('applyNodeView', () => {
  it('reduces to structure in 骨架', () => {
    expect(applyNodeView(realShape, [session('s')], 'ends').nodes).toHaveLength(2)
  })

  it('keeps every node in 关键节点 and 全部步骤', () => {
    expect(applyNodeView(realShape, [session('s')], 'key').nodes).toBe(realShape)
    expect(applyNodeView(realShape, [session('s')], 'full').nodes).toBe(realShape)
    expect(applyNodeView(realShape, [session('s')], 'key').badges).toEqual({})
  })
})