import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionTreeGraph, SessionTreeNode, SessionTreeSessionEntry } from '@shared/session-tree'
import { NODE_H, NODE_W, activePathOf, sessionBounds, tidyLayout } from './layout'

export type GraphDetail = 'collapsed' | 'full'

interface RoleStyle {
  /** Complete Tailwind utility (dynamic class names are not detected by Tailwind). */
  fill: string
  label: string
  icon: string
}

const ROLE_STYLES: Record<string, RoleStyle> = {
  user: { fill: 'fill-accent', label: 'User', icon: '👤' },
  assistant: { fill: 'fill-info', label: 'Assistant', icon: '🤖' },
  tool: { fill: 'fill-warn', label: 'Tool', icon: '🛠' },
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

export default function SessionFamilyGraph({ graph, selectedId, onSelect, onOpenSession }: {
  graph: SessionTreeGraph
  selectedId: string | null
  onSelect: (node: SessionTreeNode) => void
  onOpenSession: (session: SessionTreeSessionEntry) => void
}) {
  const layout = useMemo(() => tidyLayout(graph.nodes), [graph.nodes])
  const activePath = useMemo(() => activePathOf(graph.nodes, graph.focusKey), [graph.nodes, graph.focusKey])
  const sessionByKey = useMemo(() => new Map(graph.sessions.map(session => [session.key, session])), [graph.sessions])
  const nodeById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of graph.nodes) if (node.parentId) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1)
    return counts
  }, [graph.nodes])

  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ pointerX: number; pointerY: number; view: ViewState } | null>(null)
  const fittedFor = useRef<string | null>(null)
  const [view, setView] = useState<ViewState>({ x: 24, y: 20, k: 1 })
  const [dragging, setDragging] = useState(false)

  const fit = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height || !layout.width || !layout.height) {
      setView({ x: 24, y: 20, k: 1 })
      return
    }
    const padding = 56
    const scale = Math.max(MIN_FIT_ZOOM, Math.min(MAX_ZOOM, Math.min(
      1,
      (rect.width - padding * 2) / layout.width,
      (rect.height - padding * 2) / layout.height,
    )))
    setView({
      x: Math.max(12, (rect.width - layout.width * scale) / 2),
      y: Math.max(12, (rect.height - layout.height * scale) / 2),
      k: scale,
    })
  }, [layout.width, layout.height])

  // Native wheel listener: React's synthetic onWheel is passive at the root, so
  // preventDefault() there does not stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
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
  }, [])

  // Fit once per focused session, not on every revision bump: a live session
  // re-stamps generatedAt on each refetch, and re-fitting would fight the user's
  // pan/zoom.
  useEffect(() => {
    if (fittedFor.current === graph.focusKey) return
    fittedFor.current = graph.focusKey
    fit()
  }, [graph.focusKey, fit])

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
    onSelect(node)
  }, [onSelect])

  const focusSession = sessionByKey.get(graph.focusKey)

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

          {/* Edges */}
          {graph.nodes.map(node => {
            if (!node.parentId) return null
            const from = layout.positions.get(node.parentId)
            const to = layout.positions.get(node.id)
            const parent = nodeById.get(node.parentId)
            if (!from || !to || !parent) return null
            const crossSession = parent.sessionKey !== node.sessionKey
            const onActivePath = activePath.has(node.id) && activePath.has(node.parentId)
            const ax = from.x + NODE_W
            const ay = from.y + NODE_H / 2
            const bx = to.x
            const by = to.y + NODE_H / 2
            return (
              <g key={`edge-${node.id}`}>
                <path
                  d={`M${ax},${ay} C${ax + 52},${ay} ${bx - 52},${by} ${bx},${by}`}
                  fill="none"
                  strokeWidth={crossSession ? 2 : 1.5}
                  strokeDasharray={crossSession ? '5 4' : undefined}
                  className={onActivePath ? 'stroke-accent' : 'stroke-border-strong'}
                  opacity={onActivePath ? 1 : 0.45}
                />
                {crossSession && (
                  <text x={(ax + bx) / 2} y={(ay + by) / 2 - 7} textAnchor="middle" className="text-2xs fill-info">
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
            const branchCount = childCounts.get(node.id) ?? 0
            const title = node.title || node.type
            const subtitle = node.kind === 'collapsed'
              ? node.preview
              : node.label ?? node.preview
            return (
              <g
                key={node.id}
                data-node
                tabIndex={0}
                role="button"
                aria-label={`${style.label} · ${truncate(title, 40)}${isCurrentSession ? ' · 当前会话' : ' · 点击打开该会话'}`}
                className="cursor-pointer outline-none"
                opacity={onActivePath || !isCurrentSession ? 0.6 : 1}
                onClick={() => onSelect(node)}
                onKeyDown={event => onNodeKeyDown(event, node)}
              >
                {node.id === selectedId && (
                  <rect
                    x={x - 5}
                    y={y - 5}
                    width={NODE_W + 10}
                    height={NODE_H + 10}
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
                  height={NODE_H}
                  rx={10}
                  className={onActivePath ? 'fill-card stroke-accent' : 'fill-card stroke-border'}
                  strokeWidth={1}
                />
                <rect x={x} y={y + 9} width={3} height={NODE_H - 18} rx={1.5} className={style.fill} />
                <text x={x + 13} y={y + 19} className="text-2xs">
                  {style.icon}
                </text>
                <text x={x + 32} y={y + 19} className={`text-2xs font-medium ${style.fill}`}>
                  {style.label}
                </text>
                {node.tools?.length ? (
                  <text x={x + NODE_W - 10} y={y + 19} textAnchor="end" className="text-2xs fill-muted">
                    {truncate(node.tools.join(' · '), 16)}
                  </text>
                ) : null}
                <text x={x + 13} y={y + 36} className="text-meta fill-text-strong">
                  {truncate(title, 24)}
                </text>
                {subtitle ? (
                  <text x={x + 13} y={y + 52} className="text-2xs fill-muted">
                    {truncate(subtitle, 26)}
                  </text>
                ) : null}
                {node.isHead && (
                  <>
                    <rect x={x + NODE_W - 48} y={y - 8} width={44} height={15} rx={7.5} className="fill-accent" />
                    <text x={x + NODE_W - 26} y={y + 3} textAnchor="middle" className="text-2xs font-semibold fill-accent-fg">
                      HEAD
                    </text>
                  </>
                )}
                {branchCount > 1 && (
                  <text x={x + NODE_W + 4} y={y + NODE_H / 2 + 4} className="text-2xs font-semibold fill-accent">
                    {branchCount}
                  </text>
                )}
                {!isCurrentSession && (
                  <text x={x + NODE_W - 10} y={y + NODE_H - 5} textAnchor="end" className="text-2xs fill-info">
                    ↗
                  </text>
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
          title="适配视图"
        >适配</button>
      </div>

      <div className="absolute bottom-3 left-3 grid gap-1 rounded-lg border border-border bg-panel px-3 py-2 shadow-md">
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="inline-block h-0.5 w-4 bg-accent" />活动路径
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="inline-block w-4 border-t border-dashed border-info" />fork 边（跨文件）
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="inline-block h-3 w-4 rounded-sm border border-border bg-card" />会话分组带
        </div>
      </div>
    </div>
  )
}