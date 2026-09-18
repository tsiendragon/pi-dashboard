import type { SessionTreeNode } from '@shared/session-tree'

/** Card size + gutters for the layered (tidy-tree) layout, in SVG units. */
export const NODE_W = 212
export const NODE_H = 60
/** Height of a folded node that was expanded in place (it lists its steps inside). */
export const NODE_H_EXPANDED = 268
/** Row height of one step inside an expanded folded node. */
export const STEP_ROW_H = 24
/** Height of the expanded card's header (the part that stays visible while the list scrolls). */
export const EXPANDED_HEADER_H = 34
/** Top offset of the step viewport inside the expanded card. */
export const EXPANDED_VIEWPORT_TOP = 62
/** Bottom strip of the expanded card: “已加载 N/M 步 · 加载更多”. */
export const EXPANDED_FOOTER_H = 20
/** Height of the expanded card's step viewport. */
export const EXPANDED_VIEWPORT_H = NODE_H_EXPANDED - EXPANDED_VIEWPORT_TOP - EXPANDED_FOOTER_H
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
 * Which way the tree grows. A long conversation reads much better top→bottom on a
 * portrait phone and left→right on a wide desktop, so the caller can let
 * {@link chooseOrientation} decide instead of hard-coding one.
 */
export type GraphOrientation = 'horizontal' | 'vertical'

/**
 * A node's rendered height. Folded nodes expanded in place are taller, so the
 * layout has to reserve the space (otherwise the card would overlap its row).
 */
export function defaultHeightOf(node: Pick<SessionTreeNode, 'expanded'>): number {
  return node.expanded ? NODE_H_EXPANDED : NODE_H
}

/**
 * Layered tree layout: depth drives the main axis, leaf order the cross axis, and a
 * parent sits at the midpoint of its children. Our data is a tree (cross-file fork
 * edges are still tree edges), so no general graph engine is needed.
 *
 * Orphans (a `parentId` pointing outside the payload, e.g. a truncated family or
 * a tail-only parse) are laid out as extra roots instead of being dropped.
 *
 * @param heightOf per-node height; defaults to {@link defaultHeightOf}.
 * @param orientation `horizontal` = depth→x (default), `vertical` = depth→y.
 */
export function tidyLayout(
  nodes: SessionTreeNode[],
  heightOf: (node: SessionTreeNode) => number = defaultHeightOf,
  orientation: GraphOrientation = 'horizontal',
): TreeLayout {
  const ids = new Set(nodes.map(node => node.id))
  const children = new Map<string | null, string[]>()
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null
    const list = children.get(parent)
    if (list) list.push(node.id)
    else children.set(parent, [node.id])
  }

  const depthOf = new Map<string, number>()
  const slotOf = new Map<string, number>()
  const visited = new Set<string>()
  let slot = 0

  const walk = (id: string, depth: number): number => {
    if (visited.has(id)) return Math.max(0, slot - 1)
    visited.add(id)
    depthOf.set(id, depth)
    const kids = children.get(id) ?? []
    let row: number
    if (!kids.length) {
      row = slot
      slot += 1
    } else {
      const childRows = kids.map(kid => walk(kid, depth + 1))
      row = (childRows[0] + childRows[childRows.length - 1]) / 2
    }
    slotOf.set(id, row)
    return row
  }

  for (const root of children.get(null) ?? []) walk(root, 0)
  for (const node of nodes) if (!visited.has(node.id)) walk(node.id, 0)

  const byNode = new Map(nodes.map(node => [node.id, node]))
  const positions = new Map<string, LayoutPosition>()

  if (orientation === 'horizontal') {
    // depth → x, leaf slot → y
    for (const node of nodes) {
      positions.set(node.id, {
        x: (depthOf.get(node.id) ?? 0) * (NODE_W + GAP_X),
        y: (slotOf.get(node.id) ?? 0) * (NODE_H + GAP_Y),
      })
    }
    // A tall card only risks overlapping nodes in the SAME depth column, so resolve
    // vertical overlap per column and leave the tree shape alone.
    const columns = new Map<number, string[]>()
    for (const node of nodes) {
      const position = positions.get(node.id)
      if (!position) continue
      const list = columns.get(position.x)
      if (list) list.push(node.id)
      else columns.set(position.x, [node.id])
    }
    for (const column of columns.values()) {
      column.sort((a, b) => (positions.get(a)?.y ?? 0) - (positions.get(b)?.y ?? 0))
      for (let index = 1; index < column.length; index += 1) {
        const previous = positions.get(column[index - 1])
        const current = positions.get(column[index])
        const previousNode = byNode.get(column[index - 1])
        if (!previous || !current || !previousNode) continue
        const minimum = previous.y + heightOf(previousNode) + GAP_Y
        if (current.y < minimum) positions.set(column[index], { x: current.x, y: minimum })
      }
    }
  } else {
    // depth → y, leaf slot → x. Each depth level is a horizontal band whose height
    // is the tallest card in it (an expanded folded run is 268px, not 60px).
    const levelHeight = new Map<number, number>()
    for (const node of nodes) {
      const depth = depthOf.get(node.id) ?? 0
      levelHeight.set(depth, Math.max(levelHeight.get(depth) ?? NODE_H, heightOf(node)))
    }
    const levelY = new Map<number, number>()
    let cursor = 0
    for (const depth of [...levelHeight.keys()].sort((a, b) => a - b)) {
      levelY.set(depth, cursor)
      cursor += (levelHeight.get(depth) ?? NODE_H) + GAP_Y
    }
    for (const node of nodes) {
      positions.set(node.id, {
        x: (slotOf.get(node.id) ?? 0) * (NODE_W + GAP_X),
        y: levelY.get(depthOf.get(node.id) ?? 0) ?? 0,
      })
    }
  }

  let width = 0
  let height = 0
  for (const node of nodes) {
    const position = positions.get(node.id)
    if (!position) continue
    width = Math.max(width, position.x + NODE_W)
    height = Math.max(height, position.y + heightOf(node))
  }
  return { positions, width, height }
}

/** Padding `fit()` leaves around the content, mirrored here for scoring. */
export const FIT_PADDING = 56

/** Biggest scale at which a layout still fits inside a container (clamped to 1). */
export function fitScale(layout: TreeLayout, containerWidth: number, containerHeight: number): number {
  if (!containerWidth || !containerHeight || !layout.width || !layout.height) return 1
  return Math.max(0.05, Math.min(
    1,
    (containerWidth - FIT_PADDING * 2) / layout.width,
    (containerHeight - FIT_PADDING * 2) / layout.height,
  ))
}

/**
 * Pick the orientation that renders BIGGER in this container — i.e. the one whose
 * `fit` scale is higher. A 5-node chain is 1440px wide but 60px tall, so a portrait
 * phone scores the vertical layout far better and the line stops shrinking into
 * unreadable cards.
 *
 * `hysteresis` (>1) makes the comparison prefer the incumbent/horizontal on close
 * calls, so the graph does not flip-flop while the user resizes a window.
 */
export function chooseOrientation(
  horizontal: TreeLayout,
  vertical: TreeLayout,
  containerWidth: number,
  containerHeight: number,
  hysteresis = 1.08,
): GraphOrientation {
  const horizontalScale = fitScale(horizontal, containerWidth, containerHeight)
  const verticalScale = fitScale(vertical, containerWidth, containerHeight)
  return verticalScale > horizontalScale * hysteresis ? 'vertical' : 'horizontal'
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
  heightOf: (node: SessionTreeNode) => number = defaultHeightOf,
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
    maxY = Math.max(maxY, position.y + heightOf(node))
  }
  if (!found) return null
  return {
    x: minX - BAND_PAD_X,
    y: minY - BAND_PAD_TOP,
    width: maxX - minX + BAND_PAD_X * 2,
    height: maxY - minY + BAND_PAD_TOP + BAND_PAD_BOTTOM,
  }
}