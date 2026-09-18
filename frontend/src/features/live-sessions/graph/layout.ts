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
/** Most depth columns a single serpentine row may hold before the rows get uselessly short. */
export const MAX_SERPENTINE_COLUMNS = 12

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
 * Which way the tree grows.
 *
 * - `horizontal` depth → x (a wide left→right tree)
 * - `vertical` depth → y (a top→down tree, best for a portrait phone)
 * - `serpentine` depth → x but **wrapped onto several rows** (boustrophedon), so a
 *   long chain fills the canvas instead of forming one enormous line. The wrap is
 *   placed so consecutive depths stay neighbours, which is why no curved
 *   "return" edge is needed.
 */
export type GraphOrientation = 'horizontal' | 'vertical' | 'serpentine'

/**
 * A node's rendered height. Folded nodes expanded in place are taller, so the
 * layout has to reserve the space (otherwise the card would overlap its row).
 */
export function defaultHeightOf(node: Pick<SessionTreeNode, 'expanded'>): number {
  return node.expanded ? NODE_H_EXPANDED : NODE_H
}

/** Depth (`depthOf`) and leaf-slot (`slotOf`) per node — the shared basis of every layout. */
export interface TreeOrder {
  depthOf: Map<string, number>
  slotOf: Map<string, number>
  maxDepth: number
}

/**
 * DFS a node list into depth + leaf-slot coordinates. A parent's slot is the
 * midpoint of its children's slots, which is what keeps a tree centred on its
 * children. Orphans (parent outside the payload) become extra roots.
 */
export function computeTreeOrder(nodes: SessionTreeNode[]): TreeOrder {
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
  let maxDepth = 0

  const walk = (id: string, depth: number): number => {
    if (visited.has(id)) return Math.max(0, slot - 1)
    visited.add(id)
    depthOf.set(id, depth)
    maxDepth = Math.max(maxDepth, depth)
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
  return { depthOf, slotOf, maxDepth }
}

/**
 * Push apart nodes that would otherwise overlap because a card is taller than the
 * default row (an expanded folded run is 268px, not 60px). `groupOf` selects which
 * nodes must not overlap; nodes are only ever pushed DOWN along y.
 */
function resolveColumnOverlap(
  nodes: SessionTreeNode[],
  positions: Map<string, LayoutPosition>,
  heightOf: (node: SessionTreeNode) => number,
  groupOf: (node: SessionTreeNode) => string,
): void {
  const byNode = new Map(nodes.map(node => [node.id, node]))
  const groups = new Map<string, string[]>()
  for (const node of nodes) {
    const key = groupOf(node)
    const list = groups.get(key)
    if (list) list.push(node.id)
    else groups.set(key, [node.id])
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (positions.get(a)?.y ?? 0) - (positions.get(b)?.y ?? 0))
    for (let index = 1; index < group.length; index += 1) {
      const previous = positions.get(group[index - 1])
      const current = positions.get(group[index])
      const previousNode = byNode.get(group[index - 1])
      if (!previous || !current || !previousNode) continue
      const minimum = previous.y + heightOf(previousNode) + GAP_Y
      if (current.y < minimum) positions.set(group[index], { x: current.x, y: minimum })
    }
  }
}

function boundsOf(
  nodes: SessionTreeNode[],
  positions: Map<string, LayoutPosition>,
  heightOf: (node: SessionTreeNode) => number,
): TreeLayout {
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
  orientation: Exclude<GraphOrientation, 'serpentine'> = 'horizontal',
): TreeLayout {
  const order = computeTreeOrder(nodes)
  const { depthOf, slotOf } = order
  const positions = new Map<string, LayoutPosition>()

  if (orientation === 'horizontal') {
    // depth → x, leaf slot → y
    for (const node of nodes) {
      positions.set(node.id, {
        x: (depthOf.get(node.id) ?? 0) * (NODE_W + GAP_X),
        y: (slotOf.get(node.id) ?? 0) * (NODE_H + GAP_Y),
      })
    }
    // A tall card only risks overlapping nodes in the SAME depth column.
    resolveColumnOverlap(nodes, positions, heightOf,
      node => String(depthOf.get(node.id) ?? 0))
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

  return boundsOf(nodes, positions, heightOf)
}

/**
 * Serpentine ("牛耕式") layout: the same tidy tree, but the depth axis is cut into
 * rows of `columns` depth columns and every other row runs backwards. Because a
 * reversed row starts where the previous one ended, depth `k` and depth `k + 1`
 * always end up as neighbours — so a 2000-step chain becomes a compact grid that
 * fills the canvas, and the wrap edge is a plain vertical line rather than an arc
 * that has to loop back across the whole row.
 */
export function serpentineLayout(
  nodes: SessionTreeNode[],
  heightOf: (node: SessionTreeNode) => number = defaultHeightOf,
  columns = 4,
): TreeLayout {
  const { depthOf, slotOf, maxDepth } = computeTreeOrder(nodes)
  const width = Math.max(1, Math.min(Math.round(columns), maxDepth + 1))
  const rowOf = (depth: number): number => Math.floor(depth / width)
  const columnOf = (depth: number): number => {
    const column = depth % width
    return rowOf(depth) % 2 === 0 ? column : width - 1 - column
  }

  const positions = new Map<string, LayoutPosition>()
  for (const node of nodes) {
    positions.set(node.id, {
      x: columnOf(depthOf.get(node.id) ?? 0) * (NODE_W + GAP_X),
      // Local y = the tidy-tree slot, so a parent still sits at the midpoint of
      // its children inside its row band.
      y: (slotOf.get(node.id) ?? 0) * (NODE_H + GAP_Y),
    })
  }
  // Tall cards can only collide inside the same row band + visual column.
  resolveColumnOverlap(nodes, positions, heightOf,
    node => `${rowOf(depthOf.get(node.id) ?? 0)}:${columnOf(depthOf.get(node.id) ?? 0)}`)

  // Stack the row bands; each band is as tall as its tallest column.
  const bandOf = new Map<string, number>()
  const bandHeight = new Map<number, number>()
  for (const node of nodes) {
    const band = rowOf(depthOf.get(node.id) ?? 0)
    bandOf.set(node.id, band)
    const position = positions.get(node.id)
    if (!position) continue
    bandHeight.set(band, Math.max(bandHeight.get(band) ?? NODE_H, position.y + heightOf(node)))
  }
  const bandY = new Map<number, number>()
  let cursor = 0
  for (const band of [...bandHeight.keys()].sort((a, b) => a - b)) {
    bandY.set(band, cursor)
    cursor += (bandHeight.get(band) ?? NODE_H) + GAP_Y
  }
  for (const node of nodes) {
    const position = positions.get(node.id)
    if (!position) continue
    positions.set(node.id, { x: position.x, y: position.y + (bandY.get(bandOf.get(node.id) ?? 0) ?? 0) })
  }

  return boundsOf(nodes, positions, heightOf)
}

/** One candidate layout together with how big it renders in the current container. */
export interface LayoutCandidate {
  orientation: GraphOrientation
  /** Depth columns per row; only set for `serpentine`. */
  columns?: number
  layout: TreeLayout
  scale: number
}

/** Padding `fit()` leaves around the content, mirrored here for scoring. */
export const FIT_PADDING = 56
/** Never auto-zoom past this: cards are 212px wide, 1.6× is already very large. */
export const MAX_FIT_ZOOM = 1.6

/** Biggest scale at which a layout still fits inside a container. */
export function fitScale(
  layout: TreeLayout,
  containerWidth: number,
  containerHeight: number,
  maxZoom = 1,
): number {
  if (!containerWidth || !containerHeight || !layout.width || !layout.height) return maxZoom
  return Math.max(0.05, Math.min(
    maxZoom,
    (containerWidth - FIT_PADDING * 2) / layout.width,
    (containerHeight - FIT_PADDING * 2) / layout.height,
  ))
}

/**
 * How much of the canvas the fitted content actually covers, after `fit()` scales it
 * to touch the nearer edge. This is the “充分利用画布” objective: when a layout is
 * limited by the canvas WIDTH, the fill equals `contentHeight / contentWidth` —
 * i.e. it rewards layouts whose **aspect ratio matches the canvas**, so a long chain
 * is wrapped into a compact block instead of a thin line with empty space around it.
 *
 * The zoom cap keeps a 3-node graph from “filling” the canvas by being blown up
 * to billboard size.
 */
export function canvasFill(
  layout: TreeLayout,
  containerWidth: number,
  containerHeight: number,
  maxZoom = MAX_FIT_ZOOM,
): number {
  const usableWidth = containerWidth - FIT_PADDING * 2
  const usableHeight = containerHeight - FIT_PADDING * 2
  if (usableWidth <= 0 || usableHeight <= 0 || !layout.width || !layout.height) return 0
  const scale = Math.min(maxZoom, usableWidth / layout.width, usableHeight / layout.height)
  return Math.min(1, (layout.width * scale) * (layout.height * scale) / (usableWidth * usableHeight))
}

/**
 * Every layout worth considering for this container, each scored by
 * {@link canvasFill} — “can this shape be drawn large enough to fill the canvas”.
 * The caller picks the maximum: a wide desktop keeps a left→right tree, a portrait
 * phone turns it top→down, and a 1000-step chain wraps into rows instead of becoming
 * a 300 000px line.
 */
export function layoutCandidates(
  nodes: SessionTreeNode[],
  heightOf: (node: SessionTreeNode) => number,
  containerWidth: number,
  containerHeight: number,
  maxColumns = MAX_SERPENTINE_COLUMNS,
): LayoutCandidate[] {
  const score = (layout: TreeLayout): number => canvasFill(layout, containerWidth, containerHeight)
  const candidates: LayoutCandidate[] = [
    { orientation: 'horizontal', layout: tidyLayout(nodes, heightOf, 'horizontal'), scale: 0 },
    { orientation: 'vertical', layout: tidyLayout(nodes, heightOf, 'vertical'), scale: 0 },
  ]
  const { maxDepth } = computeTreeOrder(nodes)
  const columnLimit = Math.min(maxDepth + 1, maxColumns)
  for (let columns = 2; columns <= columnLimit; columns += 1) {
    candidates.push({
      orientation: 'serpentine',
      columns,
      layout: serpentineLayout(nodes, heightOf, columns),
      scale: 0,
    })
  }
  for (const candidate of candidates) candidate.scale = score(candidate.layout)
  return candidates
}

/**
 * Best-scoring candidate. Ties (and near ties) keep the earlier, more familiar
 * layout, which stops the graph from flip-flopping while a window is resized.
 */
export function pickBestLayout(candidates: LayoutCandidate[], minorImprovement = 1.02): LayoutCandidate {
  let best = candidates[0]
  for (const candidate of candidates) {
    if (candidate.scale > best.scale * minorImprovement) best = candidate
  }
  return best
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