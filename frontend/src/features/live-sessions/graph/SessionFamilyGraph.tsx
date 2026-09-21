import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionTreeGraph, SessionTreeNode, SessionTreeSessionEntry } from '@shared/session-tree'
import {
  EXPANDED_FOOTER_H,
  EXPANDED_VIEWPORT_H,
  EXPANDED_VIEWPORT_TOP,
  NODE_H_EXPANDED,
  NODE_W,
  STEP_ROW_H,
  activePathOf,
  defaultHeightOf,
  fitScale,
  GAP_Y,
  GAP_Y_BADGED,
  layoutCandidates,
  pickBestLayout,
  MAX_FIT_ZOOM,
  sessionBounds,
  type GraphOrientation,
  type LayoutCandidate,
  type LayoutPosition,
} from './layout'

export type GraphDetail = 'collapsed' | 'full'
/** `auto` scores every shape and keeps whichever fills the canvas best. */
export type LayoutPreference = 'auto' | GraphOrientation

const LAYOUT_CYCLE: LayoutPreference[] = ['auto', 'horizontal', 'vertical', 'serpentine']

function layoutPreferenceLabel(preference: LayoutPreference, picked: LayoutCandidate): string {
  const shape = picked.orientation === 'serpentine' ? `蛇形×${picked.columns}` : picked.orientation === 'vertical' ? '竖排' : '横排'
  return preference === 'auto' ? ` 自动（${shape}）` : shape
}

/** Track an element's box so the graph can react to the container it sits in. */
function useElementSize<T extends Element>(ref: React.RefObject<T | null>): { width: number; height: number } {  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      setSize(current => current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** Rough text width at the 10px `text-2xs` size, used to avoid overlaps. */
export function estimateTextWidth(text: string): number {
  let width = 0
  for (const char of text) width += /[\u1100-\u9fff\uff00-\uffef]/.test(char) ? 10 : 6
  return width
}

/** How many half-width chars fit in `width` px. */
function fitChars(width: number): number {
  return Math.max(4, Math.floor(width / 6))
}

/**
 * Score a layout for the canvas size that has stopped changing. Picking a shape is
 * ~30ms on a 1600-node graph, so following every resize frame would jank a window
 * drag; the drawn content still re-fits live.
 */
function useSettledSize(size: { width: number; height: number }, delayMs = 150): { width: number; height: number } {
  const [settled, setSettled] = useState(size)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(size), delayMs)
    return () => clearTimeout(timer)
  }, [size.width, size.height, delayMs])
  return settled
}

/** Sanitize an entry id into something usable inside an SVG `url(#...)` reference. */
function cssId(nodeId: string): string {
  return `clip-${nodeId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

interface RoleStyle {
  /** Complete Tailwind utility (dynamic class names are not detected by Tailwind). */
  fill: string
  label: string
  icon: string
}

const ROLE_STYLES: Record<string, RoleStyle> = {
  user: { fill: 'fill-accent', label: 'User', icon: '👤' },
  assistant: { fill: 'fill-info', label: 'Assistant', icon: '' },
  tool: { fill: 'fill-warn', label: 'Tool', icon: '' },
  system: { fill: 'fill-muted', label: 'System', icon: '⚙' },
  compaction: { fill: 'fill-ok', label: 'Compaction', icon: '📦' },
  branchSummary: { fill: 'fill-clarify', label: 'Branch summary', icon: '📋' },
  custom: { fill: 'fill-muted', label: 'Custom', icon: '✦' },
  collapsed: { fill: 'fill-border-strong', label: '已折叠的步骤', icon: '⋯' },
}

function styleFor(node: SessionTreeNode): RoleStyle {
  if (node.kind === 'collapsed') return ROLE_STYLES.collapsed
  return ROLE_STYLES[node.role ?? 'system'] ?? ROLE_STYLES.system
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Session keys are `<timestamp>_<uuid>`; keep the readable tail. */
function shortKey(key: string): string {
  return key.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, '')
}

interface ViewState {
  x: number
  y: number
  k: number
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 2
/**
 * `fit` will not zoom out past this. Fitting 55 cards into one screen meant ~0.10
 * scale, i.e. unreadable 21px cards; better to floor the zoom and let the user
 * pan (folding keeps families small enough that this rarely triggers).
 */
const MIN_FIT_ZOOM = 0.4

export default function SessionFamilyGraph({ graph, selectedId, onSelect, onOpenSession, onToggleExpand, onLoadMore, edgeBadges, onShowMiddle }: {
  graph: SessionTreeGraph
  selectedId: string | null
  onSelect: (node: SessionTreeNode) => void
  onOpenSession: (session: SessionTreeSessionEntry) => void
  /** Expand/collapse one folded run in place (`?expand=<run id>`). */
  onToggleExpand: (node: SessionTreeNode) => void
  /** Raise the per-run step window (`?steps=`) so a truncated run loads its next batch. */
  onLoadMore: (node: SessionTreeNode) => void
  /** `+N 步` badges on edges, keyed by the child node id (see `reduceToStructure`). */
  edgeBadges?: Record<string, number>
  /** Clicking such a badge reveals what is hidden (switches back to 关键节点). */
  onShowMiddle?: () => void
}) {
  // Refs first: the layout choice below measures the SVG box.
  const svgRef = useRef<SVGSVGElement>(null)
  const containerSize = useElementSize(svgRef)
  const settledSize = useSettledSize(containerSize)
  const canvasWidth = settledSize.width || 1200
  const canvasHeight = settledSize.height || 720
  /** Badges sit on edges, so the rows need clearance for them. */
  const rowGap = edgeBadges && Object.keys(edgeBadges).length ? GAP_Y_BADGED : GAP_Y
  const candidates = useMemo(
    () => layoutCandidates(graph.nodes, defaultHeightOf, canvasWidth, canvasHeight, undefined, rowGap),
    [graph.nodes, canvasWidth, canvasHeight, rowGap],
  )
  /** Manual override; `auto` keeps whichever candidate fills this canvas best. */
  const [layoutPreference, setLayoutPreference] = useState<LayoutPreference>('auto')
  const picked = useMemo(() => {
    if (layoutPreference === 'auto') return pickBestLayout(candidates)
    if (layoutPreference === 'serpentine') {
      // Any wrap is valid; take the wrap that fills this canvas best.
      return pickBestLayout(candidates.filter(candidate => candidate.orientation === 'serpentine'), 1)
    }
    return candidates.find(candidate => candidate.orientation === layoutPreference) ?? candidates[0]
  }, [layoutPreference, candidates])
  const layout = picked.layout
  /**
   * Cards the reader dragged themselves, in graph coordinates. The auto layout is a
   * good default but it cannot know that two crossing edges bother one particular
   * reader, so a card can be moved and everything else (edges, group bands, 适配)
   * follows it. Cleared by the 重排 button or when the layout shape changes.
   */
  const [manualPositions, setManualPositions] = useState<Record<string, LayoutPosition>>({})
  const positions = useMemo(() => {
    if (!Object.keys(manualPositions).length) return layout.positions
    const merged = new Map(layout.positions)
    for (const [id, position] of Object.entries(manualPositions)) if (merged.has(id)) merged.set(id, position)
    return merged
  }, [layout.positions, manualPositions])
  const hasManualPositions = Object.keys(manualPositions).length > 0
  /** Bounds of what is actually drawn (dragged cards included), used by `适配`. */
  const contentBox = useMemo(() => {
    let width = 0
    let height = 0
    for (const node of graph.nodes) {
      const position = positions.get(node.id)
      if (!position) continue
      width = Math.max(width, position.x + NODE_W)
      height = Math.max(height, position.y + defaultHeightOf(node))
    }
    return { width, height }
  }, [graph.nodes, positions])
  /** Group-band rectangles + their labels, drawn in two layers so labels stay readable. */
  const bands = useMemo(() => graph.sessions
    .map(session => ({ session, bounds: sessionBounds(graph.nodes, positions, session.key) }))
    .filter((band): band is { session: typeof band.session, bounds: NonNullable<typeof band.bounds> } => band.bounds !== null),
  [graph.sessions, graph.nodes, positions])
  const activePath = useMemo(() => activePathOf(graph.nodes, graph.focusKey), [graph.nodes, graph.focusKey])
  const sessionByKey = useMemo(() => new Map(graph.sessions.map(session => [session.key, session])), [graph.sessions])
  const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of graph.nodes) if (node.parentId) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1)
    return counts
  }, [graph.nodes])

  const dragRef = useRef<{ pointerX: number; pointerY: number; view: ViewState } | null>(null)
  const fittedFor = useRef<string | null>(null)
  const [view, setView] = useState<ViewState>({ x: 24, y: 20, k: 1 })
  const [dragging, setDragging] = useState(false)
  /** Id of the card currently being dragged, for the grabbing cursor. */
  const [draggingNode, setDraggingNode] = useState<string | null>(null)
  /** Bumped by 重排 so the fit effect re-runs with the new (auto) positions. */
  const [fitNonce, setFitNonce] = useState(0)
  const nodeDragRef = useRef<{ id: string; pointerX: number; pointerY: number; originX: number; originY: number; scale: number; moved: boolean } | null>(null)
  /** A real drag must not also count as a click on the card. */
  const suppressClickRef = useRef(false)
  /** Per-expanded-card step-list scroll offset, in px. */
  const [scroll, setScroll] = useState<Record<string, number>>({})

  const fit = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height || !contentBox.width || !contentBox.height) {
      setView({ x: 24, y: 20, k: 1 })
      return
    }
    const scale = Math.max(MIN_FIT_ZOOM, Math.min(MAX_FIT_ZOOM, fitScale({ positions, width: contentBox.width, height: contentBox.height }, rect.width, rect.height, MAX_FIT_ZOOM)))
    setView({
      x: Math.max(12, (rect.width - contentBox.width * scale) / 2),
      y: Math.max(12, (rect.height - contentBox.height * scale) / 2),
      k: scale,
    })
  }, [contentBox, positions])

  const maxScrollOf = useCallback((node: SessionTreeNode): number => {
    const rows = node.steps?.length ?? 0
    return Math.max(0, rows * STEP_ROW_H - EXPANDED_VIEWPORT_H)
  }, [])

  // Native wheel listener: React's synthetic onWheel is passive at the root, so
  // preventDefault() there does not stop the page from scrolling. Wheeling over an
  // expanded card scrolls its step list instead of zooming the canvas.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const card = (event.target as Element | null)?.closest?.('[data-steps]')
      const cardId = card?.getAttribute('data-steps')
      if (cardId) {
        const node = nodeById.get(cardId)
        if (node?.expanded) {
          const limit = maxScrollOf(node)
          setScroll(current => {
            const next = Math.max(0, Math.min(limit, (current[cardId] ?? 0) + (event.deltaY > 0 ? STEP_ROW_H : -STEP_ROW_H)))
            return next === (current[cardId] ?? 0) ? current : { ...current, [cardId]: next }
          })
          return
        }
      }
      const rect = svg.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      setView(current => {
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.k * (event.deltaY < 0 ? 1.1 : 0.9)))
        const ratio = next / current.k
        return {
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
          k: next,
        }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [nodeById, maxScrollOf])

  // Fit once per focused session, not on every revision bump: a live session
  // re-stamps generatedAt on each refetch, and re-fitting would fight the user's
  // pan/zoom.
  useEffect(() => {
    const key = `${graph.focusKey}|${picked.orientation}|${picked.columns ?? ''}|${layout.width}x${layout.height}|${fitNonce}`
    if (fittedFor.current === key) return
    fittedFor.current = key
    fit()
  }, [graph.focusKey, picked, layout, fitNonce, fit])

  // A manual arrangement belongs to one shape; switching 横排/竖排/蛇形 or opening
  // another session starts from the auto layout again.
  useEffect(() => { setManualPositions({}) }, [graph.focusKey, picked.orientation, picked.columns])

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    suppressClickRef.current = false
    // Dragging a card moves THAT card; dragging the background pans the canvas.
    const cardId = (event.target as Element).closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
    const position = cardId ? positions.get(cardId) : undefined
    if (cardId && position) {
      nodeDragRef.current = {
        id: cardId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        originX: position.x,
        originY: position.y,
        scale: view.k,
        moved: false,
      }
      setDraggingNode(cardId)
      // NO pointer capture here: capturing on pointerdown makes the browser retarget
      // the following `click` at this SVG, so the card's step rows would stop being
      // clickable. Capture is taken lazily once the pointer actually moves.
      return
    }
    if ((event.target as Element).closest('[data-node]')) return
    // A badge on an edge is a button; leave its click alone.
    if ((event.target as Element).closest('[data-badge]')) return
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, view }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [positions, view])

  const onPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const nodeDrag = nodeDragRef.current
    if (nodeDrag) {
      const dx = event.clientX - nodeDrag.pointerX
      const dy = event.clientY - nodeDrag.pointerY
      // A few pixels of slop so a sloppy click still selects instead of nudging.
      if (!nodeDrag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
      nodeDrag.moved = true
      suppressClickRef.current = true
      // Now that this is a real drag, keep receiving moves even outside the canvas.
      if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      setManualPositions(current => ({
        ...current,
        [nodeDrag.id]: { x: nodeDrag.originX + dx / nodeDrag.scale, y: nodeDrag.originY + dy / nodeDrag.scale },
      }))
      return
    }
    const drag = dragRef.current
    if (!drag) return
    setView({
      k: drag.view.k,
      x: drag.view.x + (event.clientX - drag.pointerX),
      y: drag.view.y + (event.clientY - drag.pointerY),
    })
  }, [])

  const endDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (nodeDragRef.current) {
      nodeDragRef.current = null
      setDraggingNode(null)
      return
    }
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
  }, [])

  const onNodeKeyDown = useCallback((event: ReactKeyboardEvent<SVGGElement>, node: SessionTreeNode) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (node.kind === 'collapsed') onToggleExpand(node)
    else onSelect(node)
  }, [onSelect, onToggleExpand])

  const focusSession = sessionByKey.get(graph.focusKey)

  return (
    <div className="relative h-full w-full min-h-0">
      <svg
        ref={svgRef}
        className={`h-full w-full touch-none select-none ${dragging || draggingNode ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => { if (focusSession) onOpenSession(focusSession) }}
        role="application"
        aria-label="会话家族图谱"
      >
        <defs>
          {/*
            Arrowheads: without them the edges only say “connected”, not which way the
            conversation runs. Two variants so the arrow keeps the colour of its edge
            (the focus branch is accent, everything else is muted).
          */}
          <marker id="ls-graph-arrow" viewBox="0 0 12 10" refX="12" refY="5" markerWidth="11" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,1 L10,5 L0,9 z" className="fill-border-strong" />
          </marker>
          <marker id="ls-graph-arrow-active" viewBox="0 0 12 10" refX="12" refY="5" markerWidth="11" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,1 L10,5 L0,9 z" className="fill-accent" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* Session group bands (rects only; labels are drawn ABOVE the cards so an
              overlapping band can no longer bury them). */}
          {bands.map(({ session, bounds }) => {
            const current = session.key === graph.focusKey
            return (
              <rect
                key={`band-${session.key}`}
                data-band
                x={bounds.x}
                y={bounds.y}
                width={bounds.width}
                height={bounds.height}
                rx={14}
                className={current ? 'fill-accent-subtle stroke-accent' : 'fill-bg-elevated stroke-border'}
                strokeWidth={1}
                opacity={current ? 1 : 0.7}
              />
            )
          })}

          {/* Edges — routed along whichever axis the tree grows on */}
          {graph.nodes.map(node => {
            if (!node.parentId) return null
            const fromNode = nodeById.get(node.parentId)
            const from = positions.get(node.parentId)
            const to = positions.get(node.id)
            if (!from || !to || !fromNode) return null
            const crossSession = fromNode.sessionKey !== node.sessionKey
            const onActivePath = activePath.has(node.id) && activePath.has(node.parentId)
            const fromHeight = defaultHeightOf(fromNode)
            const toHeight = defaultHeightOf(node)
            // Route along whichever axis the two nodes are actually separated on:
            // within a row it is right→left, across a serpentine wrap it is down→up.
            const dx = (to.x + NODE_W / 2) - (from.x + NODE_W / 2)
            const dy = (to.y + toHeight / 2) - (from.y + fromHeight / 2)
            let d: string
            let labelX: number
            let labelY: number
            if (Math.abs(dx) >= Math.abs(dy)) {
              const rightwards = dx >= 0
              const ax = rightwards ? from.x + NODE_W : from.x
              const bx = rightwards ? to.x : to.x + NODE_W
              const ay = from.y + fromHeight / 2
              const by = to.y + toHeight / 2
              d = `M${ax},${ay} C${ax + (rightwards ? 52 : -52)},${ay} ${bx + (rightwards ? -52 : 52)},${by} ${bx},${by}`
              labelX = (ax + bx) / 2
              labelY = (ay + by) / 2 - 7
            } else {
              const downwards = dy >= 0
              const ay = downwards ? from.y + fromHeight : from.y
              const by = downwards ? to.y : to.y + toHeight
              const ax = from.x + NODE_W / 2
              const bx = to.x + NODE_W / 2
              d = `M${ax},${ay} C${ax},${ay + (downwards ? 44 : -44)} ${bx},${by + (downwards ? -44 : 44)} ${bx},${by}`
              labelX = (ax + bx) / 2 + 8
              labelY = (ay + by) / 2
            }
            return (
              <g key={`edge-${node.id}`}>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={2}
                  strokeDasharray={crossSession ? '5 4' : undefined}
                  markerEnd={onActivePath ? 'url(#ls-graph-arrow-active)' : 'url(#ls-graph-arrow)'}
                  className={onActivePath ? 'stroke-accent' : 'stroke-border-strong'}
                  opacity={onActivePath ? 1 : 0.75}
                />
                {crossSession && (
                  <text x={labelX} y={labelY} textAnchor="middle" className="text-2xs fill-info">
                    fork
                  </text>
                )}
                {/* 骨架 view: say how many steps the edge jumps over, and let a click
                    reveal them. */}
                {edgeBadges?.[node.id] ? (() => {
                  const text = `+${edgeBadges[node.id]} 步`
                  // Size the pill to its text so it fits a 76px column gutter instead of
                  // covering the cards on either side of a short edge.
                  const badgeWidth = estimateTextWidth(text) + 14
                  return (
                    <g
                      data-badge
                      className={onShowMiddle ? 'cursor-pointer' : undefined}
                      onClick={event => { event.stopPropagation(); onShowMiddle?.() }}
                    >
                      <rect
                        x={labelX - badgeWidth / 2}
                        y={labelY - 9}
                        width={badgeWidth}
                        height={16}
                        rx={8}
                        className="fill-bg-elevated stroke-border"
                        strokeWidth={1}
                      />
                      <text x={labelX} y={labelY + 3} textAnchor="middle" className="text-2xs fill-muted">
                        {text}
                      </text>
                    </g>
                  )
                })() : null}
              </g>
            )
          })}

          {/* Nodes */}
          {graph.nodes.map(node => {
            const position = positions.get(node.id)
            if (!position) return null
            const style = styleFor(node)
            const isCurrentSession = node.sessionKey === graph.focusKey
            const onActivePath = activePath.has(node.id)
            const { x, y } = position
            const height = defaultHeightOf(node)
            const branchCount = childCounts.get(node.id) ?? 0
            const isFolded = node.kind === 'collapsed'
            const steps = node.steps ?? []
            const scrolled = scroll[node.id] ?? 0
            const scrollLimit = maxScrollOf(node)
            const selected = node.id === selectedId
            const title = node.title || node.type
            const subtitle = isFolded ? node.preview : node.label ?? node.preview
            return (
              <g
                key={node.id}
                data-node
                data-node-id={node.id}
                {...(node.expanded ? { 'data-steps': node.id } : {})}
                tabIndex={0}
                role="button"
                aria-label={
                  `${style.label} · ${truncate(title, 40)}`
                  + (isFolded ? (node.expanded ? ' · 点击收起' : ' · 点击展开这段步骤') : '')
                  + (isCurrentSession ? ' · 当前会话' : ' · 点击打开该会话')
                }
                className="cursor-grab outline-none"
                opacity={onActivePath || !isCurrentSession ? 0.6 : 1}
                onClick={() => {
                  // A finished drag must not also select / open the card.
                  if (suppressClickRef.current) { suppressClickRef.current = false; return }
                  if (isFolded) onToggleExpand(node)
                  else onSelect(node)
                }}
                onKeyDown={event => onNodeKeyDown(event, node)}
              >
                {selected && (
                  <rect
                    x={x - 5}
                    y={y - 5}
                    width={NODE_W + 10}
                    height={height + 10}
                    rx={13}
                    fill="none"
                    strokeDasharray="4 3"
                    className="stroke-accent"
                    strokeWidth={2}
                  />
                )}
                <rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={height}
                  rx={10}
                  className={onActivePath ? 'fill-card stroke-accent' : 'fill-card stroke-border'}
                  strokeWidth={1}
                />
                <rect x={x} y={y + 9} width={3} height={Math.min(42, height - 18)} rx={1.5} className={style.fill} />
                <text x={x + 13} y={y + 19} className="text-2xs">{style.icon}</text>
                <text x={x + 32} y={y + 19} className={`text-2xs font-medium ${style.fill}`}>{style.label}</text>
                {node.tools?.length ? (
                  <text x={x + NODE_W - 10} y={y + 19} textAnchor="end" className="text-2xs fill-muted">
                    {truncate(node.tools.join(' · '), 16)}
                  </text>
                ) : null}
                {/* Folded node: the affordance on the right says 展开 / 收起. */}
                {isFolded && (
                  <text x={x + NODE_W - 10} y={y + 19} textAnchor="end" className="text-2xs fill-muted">
                    {node.expanded ? '▼ 收起' : '▶ 展开'}
                  </text>
                )}
                <text x={x + 13} y={y + 36} className="text-meta fill-text-strong">{truncate(title, 24)}</text>
                {subtitle && !isFolded ? (
                  <text x={x + 13} y={y + 52} className="text-2xs fill-muted">{truncate(subtitle, 26)}</text>
                ) : null}
                {isFolded && !node.expanded ? (
                  <text x={x + 13} y={y + 52} className="text-2xs fill-muted">{truncate(subtitle ?? '', 26)}</text>
                ) : null}

                {/* Expanded in place: the run's real steps, scrolling INSIDE the card
                    so the canvas layout never grows. */}
                {isFolded && node.expanded ? (
                  <g>
                    <text x={x + 13} y={y + 52} className="text-2xs fill-muted">
                      {steps.length}/{node.collapsedCount} 步{node.stepsTruncated ? '' : ' · 全部加载'}（卡内滚动，点某一行可选中）
                    </text>
                    <clipPath id={cssId(node.id)}>
                      <rect x={x + 1} y={y + EXPANDED_VIEWPORT_TOP} width={NODE_W - 2} height={EXPANDED_VIEWPORT_H} rx={6} />
                    </clipPath>
                    <g clipPath={`url(#${cssId(node.id)})`}>
                      <g transform={`translate(0, ${-scrolled})`}>
                        {steps.map((step, index) => {
                          const rowY = y + EXPANDED_VIEWPORT_TOP + index * STEP_ROW_H
                          const stepStyle = styleFor(step)
                          return (
                            <g
                              key={step.id}
                              className="cursor-pointer"
                              onClick={event => { event.stopPropagation(); onSelect(step) }}
                            >
                              <rect
                                x={x + 6}
                                y={rowY}
                                width={NODE_W - 12}
                                height={STEP_ROW_H - 3}
                                rx={4}
                                className={step.id === selectedId ? 'fill-accent-subtle' : 'fill-bg-elevated'}
                              />
                              <rect x={x + 6} y={rowY} width={2} height={STEP_ROW_H - 3} rx={1} className={stepStyle.fill} />
                              <text x={x + 14} y={rowY + 15} className="text-2xs fill-muted">{index + 1}</text>
                              <text x={x + 32} y={rowY + 15} className="text-2xs fill-text">
                                {truncate(`${step.title}${step.preview ? ` · ${step.preview}` : ''}`, 30)}
                              </text>
                            </g>
                          )
                        })}
                      </g>
                    </g>
                    {/* scrollbar */}
                    {scrollLimit > 0 ? (
                      <>
                        <rect x={x + NODE_W - 6} y={y + EXPANDED_VIEWPORT_TOP} width={3} height={EXPANDED_VIEWPORT_H} rx={1.5} className="fill-border" />
                        <rect
                          x={x + NODE_W - 6}
                          y={y + EXPANDED_VIEWPORT_TOP + (scrolled / (scrollLimit + EXPANDED_VIEWPORT_H)) * EXPANDED_VIEWPORT_H}
                          width={3}
                          height={Math.max(18, (EXPANDED_VIEWPORT_H / (steps.length * STEP_ROW_H)) * EXPANDED_VIEWPORT_H)}
                          rx={1.5}
                          className="fill-border-strong"
                        />
                      </>
                    ) : null}

                    {/* footer: how much of this run is loaded, and the next-batch action */}
                    {node.stepsTruncated ? (
                      <g className="cursor-pointer" onClick={event => { event.stopPropagation(); onLoadMore(node) }}>
                        <rect
                          x={x + 6}
                          y={y + NODE_H_EXPANDED - EXPANDED_FOOTER_H}
                          width={NODE_W - 12}
                          height={EXPANDED_FOOTER_H - 2}
                          rx={4}
                          className="fill-accent-subtle"
                        />
                        <text
                          x={x + NODE_W / 2}
                          y={y + NODE_H_EXPANDED - EXPANDED_FOOTER_H + 13}
                          textAnchor="middle"
                          className="text-2xs fill-accent"
                        >
                          已加载 {steps.length}/{node.collapsedCount} 步 · 加载更多
                        </text>
                      </g>
                    ) : (
                      <text
                        x={x + NODE_W / 2}
                        y={y + NODE_H_EXPANDED - EXPANDED_FOOTER_H + 13}
                        textAnchor="middle"
                        className="text-2xs fill-muted"
                      >
                        已加载全部 {steps.length} 步
                      </text>
                    )}
                  </g>
                ) : null}

                {node.isHead && (
                  <>
                    <rect x={x + NODE_W - 48} y={y - 8} width={44} height={15} rx={7.5} className="fill-accent" />
                    <text x={x + NODE_W - 26} y={y + 3} textAnchor="middle" className="text-2xs font-semibold fill-accent-fg">HEAD</text>
                  </>
                )}
                {branchCount > 1 && (
                  <text x={x + NODE_W + 4} y={y + height / 2 + 4} className="text-2xs font-semibold fill-accent">{branchCount}</text>
                )}
                {!isCurrentSession && (
                  <text x={x + NODE_W - 10} y={y + height - 5} textAnchor="end" className="text-2xs fill-info">↗</text>
                )}
              </g>
            )
          })}
        </g>

        {/* Group labels last: a label must stay readable even when another band's cards
            overlap its rectangle, hence the opaque halo. The name is truncated to the
            room left by the count on the right, so the two never collide. */}
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`} pointerEvents="none">
          {bands.map(({ session, bounds }) => {
            const current = session.key === graph.focusKey
            const countText = `${session.entryCount} 条${session.isLive ? ' · 运行中' : session.partial ? ' · 仅尾部' : ''}`
            const suffix = current ? ' · 当前' : ''
            // 12px of padding each side, 12px between the texts, plus 8px of slack so
            // a slightly wider real font still cannot collide.
            const roomForName = bounds.width - 24 - estimateTextWidth(countText) - 12 - estimateTextWidth(suffix) - 8
            return (
              <g key={`band-label-${session.key}`}>
                <text
                  x={bounds.x + 12}
                  y={bounds.y + 19}
                  stroke="var(--bg)"
                  strokeWidth={3}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  paintOrder="stroke"
                  className={`text-2xs font-medium ${current ? 'fill-accent' : 'fill-muted'}`}
                >
                  {truncate(shortKey(session.key), fitChars(roomForName))}{suffix}
                  <title>{session.key}</title>
                </text>
                <text
                  x={bounds.x + bounds.width - 12}
                  y={bounds.y + 19}
                  textAnchor="end"
                  stroke="var(--bg)"
                  strokeWidth={3}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  className="text-2xs fill-muted"
                >
                  {countText}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-border bg-panel px-1 py-1 shadow-md">
        <button
          onClick={() => setView(current => ({ ...current, k: Math.min(MAX_ZOOM, current.k * 1.15) }))}
          className="h-7 w-7 cursor-pointer rounded border-none bg-transparent text-meta text-muted transition-colors hover:bg-bg-hover hover:text-text"
          title="放大"
        >＋</button>
        <button
          onClick={() => setView(current => ({ ...current, k: Math.max(MIN_ZOOM, current.k / 1.15) }))}
          className="h-7 w-7 cursor-pointer rounded border-none bg-transparent text-meta text-muted transition-colors hover:bg-bg-hover hover:text-text"
          title="缩小"
        >－</button>
        <button
          onClick={fit}
          className="h-7 cursor-pointer rounded border-none bg-transparent px-2 text-2xs text-muted transition-colors hover:bg-bg-hover hover:text-text"
          title="适配视图（缩放下限 0.4，避免缩到不可读）"
        >适配</button>
        <button
          onClick={() => setLayoutPreference(current => {
            const index = LAYOUT_CYCLE.indexOf(current)
            return LAYOUT_CYCLE[(index + 1) % LAYOUT_CYCLE.length]
          })}
          className="h-7 cursor-pointer rounded border-none bg-transparent px-2 text-2xs text-muted transition-colors hover:bg-bg-hover hover:text-text"
          title="布局形状：自动会逐一给 横排 / 竖排 / 蛇形×N 打分（能否把卡片渲染得更大），选最优；蛇形把长链折成多行"
        >{layoutPreferenceLabel(layoutPreference, picked)}</button>
        {hasManualPositions && (
          <button
            onClick={() => { setManualPositions({}); setFitNonce(nonce => nonce + 1) }}
            className="h-7 cursor-pointer rounded border-none bg-accent-subtle px-2 text-2xs text-accent transition-colors hover:bg-bg-hover"
            title={`恢复自动布局（已有 ${Object.keys(manualPositions).length} 张卡片被手动移动）`}
          >重排</button>
        )}
      </div>

      <div className="absolute bottom-3 left-3 grid max-w-[19rem] gap-1 rounded-lg border border-border bg-panel px-2.5 py-2 shadow-md">
        <div className="flex items-center gap-2 text-2xs text-muted">
          <svg width="26" height="8" viewBox="0 0 26 8" className="shrink-0">
            <line x1="0" y1="4" x2="15" y2="4" className="stroke-accent" strokeWidth="2" />
            <path d="M15,0.5 L24,4 L15,7.5 z" className="fill-accent" />
            <line x1="0" y1="4" x2="15" y2="4" className="stroke-border-strong" strokeWidth="2" />
            <path d="M15,0.5 L24,4 L15,7.5 z" className="fill-border-strong" />
          </svg>
          <span>箭头 = 下一步（蓝 = 当前分支）</span>
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <svg width="26" height="8" viewBox="0 0 26 8" className="shrink-0">
            <line x1="0" y1="4" x2="15" y2="4" className="stroke-info" strokeWidth="2" strokeDasharray="3 2" />
            <path d="M15,0.5 L24,4 L15,7.5 z" className="fill-info" />
          </svg>
          <span>虚线 = 从这一步 fork 出的新会话</span>
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <svg width="26" height="16" viewBox="0 0 26 16" className="shrink-0">
            <rect x="2" y="2" width="22" height="12" rx="3" fill="none" strokeDasharray="4 3" className="stroke-accent" strokeWidth="1.5" />
            <rect x="1" y="1" width="24" height="14" rx="4" className="fill-accent-subtle stroke-accent" strokeWidth="1" opacity="0" />
          </svg>
          <span>虚线框 = 已选中；大圆角底色 = 同一会话文件</span>
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <svg width="26" height="16" viewBox="0 0 26 16" className="shrink-0">
            <rect x="6" y="4" width="14" height="9" rx="4.5" className="fill-bg-elevated stroke-border" strokeWidth="1" />
          </svg>
          <span>点 <code className="text-2xs">+N 步</code> 展开中间步骤；拖卡片自定位置</span>
        </div>
      </div>
    </div>
  )
}