import type { SessionTreeNode } from '@shared/session-tree'

/** Card size + gutters for the layered (tidy-tree) layout, in SVG units. */
export const NODE_W = 212
export const NODE_H = 60
export const GAP_X = 76
export const GAP_Y = 12
/** Padding added around a session's nodes when drawing its group band. */
export const BAND_PAD_X = 18
export const BAND_PAD_TOP = 30
export const BAND_PAD_BOTTOM = 16

export interface LayoutPosition {
  x: number
  y: number
}

export interface TreeLayout {
  positions: Map<string, LayoutPosition>
  width: number
  height: number
}

/**
 * Layered tree layout: depth drives x, leaf order drives y, a parent sits at the
 * vertical midpoint of its children. Our data is a tree (cross-file fork edges
 * are still tree edges), so no general graph engine is needed.
 *
 * Orphans (a `parentId` pointing outside the payload, e.g. a truncated family or
 * a tail-only parse) are laid out as extra roots instead of being dropped.
 */
export function tidyLayout(nodes: Pick<SessionTreeNode, 'id' | 'parentId'>[]): TreeLayout {
  const ids = new Set(nodes.map(node => node.id))
  const children = new Map<string | null, string[]>()
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const list = children.get(parent)
    if (list) list.push(node.id)
    else children.set(parent, [node.id])
  }

  const positions = new Map<string, LayoutPosition>()
  const visited = new Set<string>()
  let row = 0

  const walk = (id: string, depth: number): number => {
    if (visited.has(id)) return Math.max(0, row - 1)
    visited.add(id)
    const kids = children.get(id) ?? []
    let y: number
    if (!kids.length) {
      y = row
      row += 1
    } else {
      const childRows = kids.map(kid => walk(kid, depth + 1))
      y = (childRows[0] + childRows[childRows.length - 1]) / 2
    }
    positions.set(id, { x: depth * (NODE_W + GAP_X), y: y * (NODE_H + GAP_Y) })
    return y
  }

  for (const root of children.get(null) ?? []) walk(root, 0)
  for (const node of nodes) if (!visited.has(node.id)) walk(node.id, 0)

  let width = 0
  let height = 0
  for (const position of positions.values()) {
    width = Math.max(width, position.x + NODE_W)
    height = Math.max(height, position.y + NODE_H)
  }
  return { positions, width, height }
}

/** Ids on the focus session's active branch (leaf → root), used to highlight the live path. */
export function activePathOf(nodes: SessionTreeNode[], focusKey: string): Set<string> {
  const focusNodes = nodes.filter(node => node.sessionKey === focusKey)
  const byId = new Map(focusNodes.map(node => [node.id, node]))
  const leaf = focusNodes.find(node => node.isHead) ?? focusNodes[focusNodes.length - 1]
  const path = new Set<string>()
  for (let cursor = leaf?.id; cursor !== undefined;) {
    if (path.has(cursor)) break
    path.add(cursor)
    const next = byId.get(cursor)?.parentId
    if (!next) break
    cursor = next
  }
  return path
}

/** Bounding box of one session's nodes inside the layout. */
export function sessionBounds(
  nodes: SessionTreeNode[],
  positions: Map<string, LayoutPosition>,
  sessionKey: string,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false
  for (const node of nodes) {
    if (node.sessionKey !== sessionKey) continue
    const position = positions.get(node.id)
    if (!position) continue
    found = true
    minX = Math.min(minX, position.x)
    minY = Math.min(minY, position.y)
    maxX = Math.max(maxX, position.x + NODE_W)
    maxY = Math.max(maxY, position.y + NODE_H)
  }
  if (!found) return null
  return {
    x: minX - BAND_PAD_X,
    y: minY - BAND_PAD_TOP,
    width: maxX - minX + BAND_PAD_X * 2,
    height: maxY - minY + BAND_PAD_TOP + BAND_PAD_BOTTOM,
  }
}