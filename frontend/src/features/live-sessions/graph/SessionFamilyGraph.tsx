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
  chooseOrientation,
  defaultHeightOf,
  fitScale,
  sessionBounds,
  tidyLayout,
  type GraphOrientation,
} from './layout'

export type GraphDetail = 'collapsed' | 'full'
/** `auto` picks the orientation that renders bigger in the current container. */
export type OrientationPreference = 'auto' | GraphOrientation

/** Track an element's box so the graph can react to the container it sits in. */
function useElementSize<T extends Element>(ref: React.RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
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

export default function SessionFamilyGraph({ graph, selectedId, onSelect, onOpenSession, onToggleExpand, onLoadMore }: {
  graph: SessionTreeGraph
  selectedId: string | null
  onSelect: (node: SessionTreeNode) => void
  onOpenSession: (session: SessionTreeSessionEntry) => void
  /** Expand/collapse one folded run in place (`?expand=<run id>`). */
  onToggleExpand: (node: SessionTreeNode) => void
  /** Raise the per-run step window (`?steps=`) so a truncated run loads its next batch. */
  onLoadMore: (node: SessionTreeNode) => void
}) {
  // Refs first: the layout choice below measures the SVG box.
  const svgRef = useRef<SVGSVGElement>(null)
  const layoutOf = useMemo(() => ({
    horizontal: tidyLayout(graph.nodes, defaultHeightOf, 'horizontal'),
    vertical: tidyLayout(graph.nodes, defaultHeightOf, 'vertical'),
  }), [graph.nodes])
  const containerSize = useElementSize(svgRef)
  /** Manual override; `auto` defers to the container's aspect ratio. */
  const [orientationPreference, setOrientationPreference] = useState<OrientationPreference>('auto')
  const orientation: GraphOrientation = orientationPreference === 'auto'
    ? chooseOrientation(layoutOf.horizontal, layoutOf.vertical, containerSize.width, containerSize.height)
    : orientationPreference
  const layout = layoutOf[orientation]
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
  /** Per-expanded-card step-list scroll offset, in px. */
  const [scroll, setScroll] = useState<Record<string, number>>({})

  const fit = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height || !layout.width || !layout.height) {
      setView({ x: 24, y: 20, k: 1 })
      return
    }
    const scale = Math.max(MIN_FIT_ZOOM, Math.min(MAX_ZOOM, fitScale(layout, rect.width, rect.height)))
    setView({
      x: Math.max(12, (rect.width - layout.width * scale) / 2),
      y: Math.max(12, (rect.height - layout.height * scale) / 2),
      k: scale,
    })
  }, [layout])

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
    const key = `${graph.focusKey}|${orientation}`
    if (fittedFor.current === key) return
    fittedFor.current = key
    fit()
  }, [graph.focusKey, orientation, fit])

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('[data-node]')) return
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, view }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [view])

  const onPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setView({
      k: drag.view.k,
      x: drag.view.x + (event.clientX - drag.pointerX),
      y: drag.view.y + (event.clientY - drag.pointerY),
    })
  }, [])

  const endDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const onNodeKeyDown = useCallback((event: ReactKeyboardEvent<SVGGElement>, node: SessionTreeNode) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (node.kind === 'collapsed') onToggleExpand(node)
    else onSelect(node)
  }, [onSelect, onToggleExpand])

  const focusSession = sessionByKey.get(graph.focusKey)
  const expandedCount = graph.nodes.filter(node => node.expanded).length

  return (
    <div className="relative h-full w-full min-h-0">
      <svg
        ref={svgRef}
        className={`h-full w-full touch-none select-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => { if (focusSession) onOpenSession(focusSession) }}
        role="application"
        aria-label="会话家族图谱"
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* Session group bands */}
          {graph.sessions.map(session => {
            const bounds = sessionBounds(graph.nodes, layout.positions, session.key)
            if (!bounds) return null
            const current = session.key === graph.focusKey
            return (
              <g key={`band-${session.key}`} data-band>
                <rect
                  x={bounds.x}
                  y={bounds.y}
                  width={bounds.width}
                  height={bounds.height}
                  rx={14}
                  className={current ? 'fill-accent-subtle stroke-accent' : 'fill-bg-elevated stroke-border'}
                  strokeWidth={1}
                  opacity={current ? 1 : 0.7}
                />
                <text x={bounds.x + 12} y={bounds.y + 19} className={`text-2xs font-medium ${current ? 'fill-accent' : 'fill-muted'}`}>
                  {truncate(shortKey(session.key), 24)}{current ? ' · 当前' : ''}
                </text>
                <text x={bounds.x + bounds.width - 12} y={bounds.y + 19} textAnchor="end" className="text-2xs fill-muted">
                  {session.entryCount} 条{session.isLive ? ' · 运行中' : session.partial ? ' · 仅尾部' : ''}
                </text>
              </g>
            )
          })}

          {/* Edges — routed along whichever axis the tree grows on */}
          {graph.nodes.map(node => {
            if (!node.parentId) return null
            const fromNode = nodeById.get(node.parentId)
            const from = layout.positions.get(node.parentId)
            const to = layout.positions.get(node.id)
            if (!from || !to || !fromNode) return null
            const crossSession = fromNode.sessionKey !== node.sessionKey
            const onActivePath = activePath.has(node.id) && activePath.has(node.parentId)
            const fromHeight = defaultHeightOf(fromNode)
            const toHeight = defaultHeightOf(node)
            let d: string
            let labelX: number
            let labelY: number
            if (orientation === 'horizontal') {
              const ax = from.x + NODE_W
              const ay = from.y + fromHeight / 2
              const bx = to.x
              const by = to.y + toHeight / 2
              d = `M${ax},${ay} C${ax + 52},${ay} ${bx - 52},${by} ${bx},${by}`
              labelX = (ax + bx) / 2
              labelY = (ay + by) / 2 - 7
            } else {
              const ax = from.x + NODE_W / 2
              const ay = from.y + fromHeight
              const bx = to.x + NODE_W / 2
              const by = to.y
              d = `M${ax},${ay} C${ax},${ay + 44} ${bx},${by - 44} ${bx},${by}`
              labelX = (ax + bx) / 2 + 8
              labelY = (ay + by) / 2
            }
            return (
              <g key={`edge-${node.id}`}>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={crossSession ? 2 : 1.5}
                  strokeDasharray={crossSession ? '5 4' : undefined}
                  className={onActivePath ? 'stroke-accent' : 'stroke-border-strong'}
                  opacity={onActivePath ? 1 : 0.45}
                />
                {crossSession && (
                  <text x={labelX} y={labelY} textAnchor="middle" className="text-2xs fill-info">
                    fork
                  </text>
                )}
              </g>
            )
          })}

          {/* Nodes */}
          {graph.nodes.map(node => {
            const position = layout.positions.get(node.id)
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
                {...(node.expanded ? { 'data-steps': node.id } : {})}
                tabIndex={0}
                role="button"
                aria-label={
                  `${style.label} · ${truncate(title, 40)}`
                  + (isFolded ? (node.expanded ? ' · 点击收起' : ' · 点击展开这段步骤') : '')
                  + (isCurrentSession ? ' · 当前会话' : ' · 点击打开该会话')
                }
                className="cursor-pointer outline-none"
                opacity={onActivePath || !isCurrentSession ? 0.6 : 1}
                onClick={() => { if (isFolded) onToggleExpand(node); else onSelect(node) }}
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
                    strokeWidth={1.5}
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
          onClick={() => setOrientationPreference(current => current === 'auto' ? 'horizontal' : current === 'horizontal' ? 'vertical' : 'auto')}
          className="h-7 cursor-pointer rounded border-none bg-transparent px-2 text-2xs text-muted transition-colors hover:bg-bg-hover hover:text-text"
          title="布局方向：自动比较横排/竖排在本页的适配缩放，选看着更大的一种"
        >{orientationPreference === 'auto' ? `⇄ 自动（${orientation === 'vertical' ? '竖排' : '横排'}）` : orientationPreference === 'horizontal' ? '⇄ 横排' : '⇅ 竖排'}</button>
      </div>

      <div className="absolute bottom-3 left-3 grid gap-1 rounded-lg border border-border bg-panel px-3 py-2 shadow-md">
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="inline-block h-0.5 w-4 bg-accent" />活动路径
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="inline-block w-4 border-t border-dashed border-info" />fork 边（跨文件）
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="inline-block h-3 w-4 rounded-sm border border-border bg-card" />点 <code className="text-2xs">+N 步</code> 就地展开
          {expandedCount ? `（已展开 ${expandedCount}）` : ''}
        </div>
      </div>
    </div>
  )
}