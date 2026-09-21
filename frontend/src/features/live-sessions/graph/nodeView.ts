import type { SessionTreeNode, SessionTreeSessionEntry } from '@shared/session-tree'

/**
 * How much of a family the reader wants to see.
 *
 * - `ends` 骨架：只留结构点（起点、各会话首节点、分叉点/fork 锚点、当前点、标注），
 *          中间被折叠的步数标在边上
 * - `key`  关键节点（折叠段 / 总结 / 标注都画出来）
 * - `full` 每一个 entry
 */
export type GraphNodeView = 'ends' | 'key' | 'full'

export const GRAPH_NODE_VIEW_CYCLE: GraphNodeView[] = ['ends', 'key', 'full']

export function graphNodeViewLabel(view: GraphNodeView): string {
  return view === 'ends' ? '骨架' : view === 'key' ? '关键节点' : '全部步骤'
}

/** A single file with no branching — the common (97%) shape. */
export function isLinearFamily(nodes: SessionTreeNode[], sessions: SessionTreeSessionEntry[]): boolean {
  if (sessions.length > 1) return false
  return nodes.every(node => node.childCount <= 1)
}

/** Steps one node stands for (a folded run carries its own count). */
function stepsOf(node: SessionTreeNode): number {
  return node.kind === 'collapsed' ? Math.max(1, node.collapsedCount ?? 1) : 1
}

export interface EndpointView {
  nodes: SessionTreeNode[]
  /** Steps hidden on the edge into a node, keyed by that node's id (`+N 步` badge). */
  badges: Record<string, number>
  /** Total hidden steps, for the header hint. */
  hiddenSteps: number
}

/**
 * Reduce a family to its **structure**: the nodes that carry meaning about shape.
 *
 * Kept: tree roots, the first node of every session file (so a fork shows where the
 * new file began), branch points, leaves (a branch that is no longer the head must
 * not vanish), fork anchors, the current head, and anything a human labelled.
 * Everything else — folded runs, compaction summaries, plain messages in a straight
 * line — is dropped and its step count is moved onto the edge that jumps over it, so
 * nothing is silently lost.
 *
 * A linear session therefore collapses to exactly two cards (start → now), and a
 * forked family still shows every fork and branch point.
 */
export function reduceToStructure(
  nodes: SessionTreeNode[],
  sessions: SessionTreeSessionEntry[] = [],
): EndpointView {
  if (nodes.length <= 2) return { nodes, badges: {}, hiddenSteps: 0 }

  const ids = new Set(nodes.map(node => node.id))
  const children = new Map<string | null, string[]>()
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const list = children.get(parent)
    if (list) list.push(node.id)
    else children.set(parent, [node.id])
  }

  const firstOfSession = new Map<string, string>()
  for (const node of nodes) if (!firstOfSession.has(node.sessionKey)) firstOfSession.set(node.sessionKey, node.id)

  const keep = new Set<string>()
  for (const node of nodes) {
    if (!node.parentId || !ids.has(node.parentId)) keep.add(node.id)
    if (node.childCount >= 2) keep.add(node.id)
    // Leaves too: a branch that is no longer the head would otherwise vanish entirely.
    if (node.childCount === 0) keep.add(node.id)
    if (node.isHead) keep.add(node.id)
    if (node.label) keep.add(node.id)
  }
  for (const id of firstOfSession.values()) keep.add(id)
  for (const session of sessions) if (session.forkAnchorId) keep.add(session.forkAnchorId)

  const kept: SessionTreeNode[] = []
  const badges: Record<string, number> = {}
  let hiddenSteps = 0
  const visited = new Set<string>()

  const visit = (id: string, lastKept: SessionTreeNode | null, pending: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    const node = nodeById.get(id)
    if (!node) return
    let nextLast = lastKept
    let nextPending = pending
    if (keep.has(id)) {
      if (pending > 0) {
        badges[id] = pending
        hiddenSteps += pending
      }
      kept.push({ ...node, parentId: lastKept ? lastKept.id : null })
      nextLast = kept[kept.length - 1]
      nextPending = 0
    } else {
      nextPending = pending + stepsOf(node)
    }
    for (const kid of children.get(id) ?? []) visit(kid, nextLast, nextPending)
  }

  const nodeById = new Map(nodes.map(node => [node.id, node]))
  for (const root of children.get(null) ?? []) visit(root, null, 0)
  for (const node of nodes) if (!visited.has(node.id)) visit(node.id, null, 0)

  // Recompute child counts on the reduced list so branch badges stay truthful.
  const keptChildren = new Map<string, number>()
  for (const node of kept) if (node.parentId) keptChildren.set(node.parentId, (keptChildren.get(node.parentId) ?? 0) + 1)
  const reduced = kept.map(node => {
    const count = keptChildren.get(node.id) ?? 0
    return { ...node, childCount: count, isLeaf: count === 0 }
  })
  return { nodes: reduced, badges, hiddenSteps }
}

/** Apply a view mode to an already-fetched (collapsed) node list. */
export function applyNodeView(
  nodes: SessionTreeNode[],
  sessions: SessionTreeSessionEntry[],
  view: GraphNodeView,
): EndpointView {
  if (view === 'ends') return reduceToStructure(nodes, sessions)
  return { nodes, badges: {}, hiddenSteps: 0 }
}