import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAppSelector } from '../store'
import { liveSessionApi } from '../features/live-sessions/api'
import type { HistoryPoint, PlanningEntry, PlanningOverlay, SessionRef, TaskFact, TasksResponse } from '@shared/tasks.js'
import TaskDrawer from './tasks/TaskDrawer'
import TrendPanel from './tasks/TrendPanel'
import {
  COMPLETION_DOT,
  COMPLETION_LABEL,
  KIND_LABEL,
  isFocused,
  laneOf,
  matchesSearch,
  matchesStatus,
  sortTasks,
  type StatusFilter,
} from './tasks/helpers'

const VIEW_KEY = 'tasks.view'
const POLL_MS = 20_000
const GROUP_LIMIT = 20

const STATUS_CHIPS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'active', label: '活跃' },
  { id: 'doing', label: '进行中' },
  { id: 'todo', label: '待办' },
  { id: 'paused', label: '暂停' },
  { id: 'done', label: '已完成' },
  { id: 'archived', label: '归档' },
  { id: 'all', label: '全部' },
]

function TaskCard({
  task,
  entry,
  sessions,
  focused,
  showProvider,
  draggable,
  dragging,
  onDragHandle,
  onOpen,
  onTogglePin,
  onOpenSession,
}: {
  task: TaskFact
  entry: PlanningEntry | undefined
  sessions: SessionRef[]
  focused: boolean
  showProvider: boolean
  draggable?: boolean
  dragging?: boolean
  onDragHandle?: (e: ReactPointerEvent) => void
  onOpen: () => void
  onTogglePin: () => void
  onOpenSession: (pid: string) => void
}) {
  return (
    <div
      onClick={onOpen}
      draggable={draggable}
      onDragStart={draggable ? e => { e.dataTransfer.setData('text/plain', task.uid); e.dataTransfer.effectAllowed = 'move' } : undefined}
      className={`group relative bg-card border border-border rounded-lg p-3 cursor-pointer hover:border-border-strong transition ${task.archived ? 'opacity-60' : ''} ${dragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-2">
        {onDragHandle && (
          <button
            onPointerDown={onDragHandle}
            onClick={e => e.stopPropagation()}
            style={{ touchAction: 'none' }}
            className="shrink-0 -ml-1 w-5 h-5 grid place-items-center rounded text-muted cursor-grab active:cursor-grabbing hover:text-text"
            aria-label="拖动到其它泳道"
          >⠿</button>
        )}
        <span className={`w-2 h-2 rounded-full shrink-0 ${COMPLETION_DOT[task.completion]}`} title={COMPLETION_LABEL[task.completion]} />
        <span className="font-mono text-2xs text-accent truncate">{task.id}</span>
        {entry?.priority != null && <span className="text-2xs text-warn shrink-0">P{entry.priority}</span>}
        <button
          onClick={e => { e.stopPropagation(); onTogglePin() }}
          className={`ml-auto shrink-0 w-6 h-6 grid place-items-center rounded text-2xs ${focused ? 'text-accent' : 'text-muted opacity-0 group-hover:opacity-100'} hover:bg-bg-hover`}
          title={focused ? '取消聚焦' : '聚焦'}
        >
          {focused ? '★' : '☆'}
        </button>
      </div>
      <div className="text-body-s text-text-strong mt-1.5 line-clamp-2">{task.title}</div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-subtle text-accent">{KIND_LABEL[task.kind] ?? task.kind}</span>
        {showProvider && (
          <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-elevated text-muted border border-border">{task.sourceLabel}</span>
        )}
        {entry?.note && <span className="text-2xs text-muted" title={entry.note}>✎</span>}
        {task.completionRaw && <span className="text-2xs text-muted">({task.completionRaw})</span>}
        <span className="flex-1" />
        {sessions.length > 0 && (
          <button
            onClick={e => { e.stopPropagation(); const pid = sessions.find(s => s.processInstanceId)?.processInstanceId; if (pid) onOpenSession(pid) }}
            className="text-2xs text-info hover:underline"
            title={sessions.map(s => s.title || s.cwd || s.sessionId).join('\n')}
          >
            ● {sessions.length}
          </button>
        )}
      </div>
    </div>
  )
}

/** A group whose long list is collapsed by default (perf + scannability). */
function CollapsibleGroup({ title, items, limit = GROUP_LIMIT, onDrop, laneId, highlight }: { title: string; items: ReactNode[]; limit?: number; onDrop?: (uid: string) => void; laneId?: string; highlight?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [over, setOver] = useState(false)
  if (items.length === 0 && !laneId) return null
  const shown = expanded ? items : items.slice(0, limit)
  return (
    <div
      data-lane={laneId}
      className={`min-w-0 rounded-lg transition ${over || highlight ? 'ring-1 ring-accent/50 bg-accent-subtle/20' : ''}`}
      onDragOver={onDrop ? e => { e.preventDefault(); setOver(true) } : undefined}
      onDragLeave={onDrop ? () => setOver(false) : undefined}
      onDrop={onDrop ? e => { e.preventDefault(); setOver(false); const uid = e.dataTransfer.getData('text/plain'); if (uid) onDrop(uid) } : undefined}
    >
      <div className="flex items-center gap-2 mb-2 px-0.5">
        <span className="text-meta font-medium text-muted">{title}</span>
        <span className="text-2xs text-muted/70">{items.length}</span>
      </div>
      <div className="grid gap-2">
        {items.length === 0
          ? <div className="rounded-lg border border-dashed border-border py-6 text-center text-2xs text-muted">拖到这里</div>
          : shown}
      </div>
      {items.length > limit && (
        <button onClick={() => setExpanded(v => !v)} className="mt-2 text-2xs text-accent hover:underline">
          {expanded ? '收起' : `展开全部（+${items.length - limit}）`}
        </button>
      )}
    </div>
  )
}

export default function TasksPage() {
  const navigate = useNavigate()
  const params = useParams()
  const routeUid = (() => {
    const raw = params.uid
    if (!raw) return null
    try { return decodeURIComponent(raw) } catch { return raw }
  })()
  const auth = useAppSelector(s => s.liveSessions.auth)
  const [data, setData] = useState<TasksResponse | null>(null)
  const [planning, setPlanning] = useState<PlanningOverlay>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState<'execute' | 'survey' | null>(() => {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'survey' || v === 'execute' ? v : null
  })
  const [liveOptions, setLiveOptions] = useState<Array<{ sessionId: string; processInstanceId: string; title?: string; cwd: string }>>([])
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [dragUid, setDragUid] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('active')
  const [providerFilter, setProviderFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.tasks()
      setData(res)
      setPlanning(res.planning || {})
      setView(v => v ?? (res.defaultView === 'survey' ? 'survey' : 'execute'))
      setError('')
    } catch (e: any) {
      setError(e?.message || '加载任务失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => { if (view) localStorage.setItem(VIEW_KEY, view) }, [view])

  // Deep link: /tasks/:uid opens that task's drawer.
  useEffect(() => { if (routeUid) setSelected(routeUid) }, [routeUid])

  // Trend data — fetched when the survey (planning) view is shown.
  useEffect(() => {
    if (view !== 'survey') return
    let alive = true
    api.taskHistory(30).then(r => { if (alive) setHistory(r.points || []) }).catch(() => {})
    return () => { alive = false }
  }, [view])

  const openTask = useCallback((uid: string) => {
    setSelected(uid)
    navigate(`/tasks/${encodeURIComponent(uid)}`)
  }, [navigate])

  const closeDrawer = useCallback(() => {
    setSelected(null)
    if (routeUid) navigate('/tasks')
  }, [routeUid, navigate])

  const updatePlanning = useCallback(async (uid: string, patch: PlanningEntry) => {
    const prev = planning
    const next: PlanningOverlay = { ...planning }
    const merged: PlanningEntry = { ...(planning[uid] || {}), ...patch }
    for (const key of Object.keys(merged) as (keyof PlanningEntry)[]) {
      if (merged[key] === undefined || merged[key] === null) delete merged[key]
    }
    if (Object.keys(merged).length) next[uid] = merged
    else delete next[uid]
    setPlanning(next)
    try {
      const res: any = await api.saveTaskPlanning({ [uid]: patch })
      if (res?.overlay) setPlanning(res.overlay)
      if (Array.isArray(res?.rejected) && res.rejected.includes(uid)) setError('该条目不支持规划（身份不稳定）')
    } catch (e: any) {
      setPlanning(prev)
      setError(e?.message || '规划保存失败')
    }
  }, [planning])

  const togglePin = useCallback((uid: string) => {
    updatePlanning(uid, { pinned: !planning[uid]?.pinned })
  }, [planning, updatePlanning])

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim()
    if (!title) return
    try {
      await api.createTask({ title })
      setNewTitle('')
      setCreating(false)
      await load()
    } catch (e: any) {
      setError(e?.message || '创建失败')
    }
  }, [newTitle, load])

  const handleEdit = useCallback(async (uid: string, patch: { title?: string; description?: string; status?: string; tags?: string[] }) => {
    try {
      await api.updateTask(uid, patch)
      await load()
    } catch (e: any) {
      setError(e?.message || '更新失败')
    }
  }, [load])

  const handleDelete = useCallback(async (uid: string) => {
    try {
      await api.deleteTask(uid)
      setSelected(null)
      await load()
    } catch (e: any) {
      setError(e?.message || '删除失败')
    }
  }, [load])

  const authReady = auth === 'authenticated'

  useEffect(() => {
    if (!authReady) return
    let alive = true
    liveSessionApi.list()
      .then(r => {
        if (!alive) return
        setLiveOptions((r.sessions ?? []).map(s => ({
          sessionId: s.sessionId,
          processInstanceId: s.processInstanceId,
          title: s.sessionName,
          cwd: s.canonicalCwd || s.cwd,
        })))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [authReady])
  const startSession = useCallback(async (task: TaskFact) => {
    if (!task.path) { setError('该任务没有工作目录，无法起会话'); return }
    if (!authReady) { setError('请先在 Live Pi 页面完成认证，再起会话'); return }
    try {
      const res = await liveSessionApi.start({ cwd: task.path, title: task.title.slice(0, 80) }) as unknown as { processInstanceId?: string; slotKey?: string }
      const pid = res?.processInstanceId || res?.slotKey
      setError('')
      if (pid) navigate(`/live-sessions/${encodeURIComponent(pid)}`)
      else await load()
    } catch (e: any) {
      setError(e?.message || '起会话失败')
    }
  }, [authReady, navigate, load])

  const providers = data?.providers ?? []
  const lanes = data?.lanes ?? []
  const sessionRefs = data?.sessionRefs ?? {}
  const writable = providers.some(p => p.capabilities.writable)
  const showProvider = providers.length > 1

  const filtered = useMemo(() => {
    const tasks = data?.tasks ?? []
    return tasks
      .filter(t => matchesStatus(t, status) && matchesSearch(t, search) && (providerFilter === 'all' || t.providerId === providerFilter))
      .sort((a, b) => sortTasks(a, b, planning))
  }, [data, status, search, providerFilter, planning])

  const focused = useMemo(() => filtered.filter(t => isFocused(t.uid, planning)), [filtered, planning])
  const unfocused = useMemo(() => filtered.filter(t => !isFocused(t.uid, planning)), [filtered, planning])

  const stats = useMemo(() => {
    const all = data?.tasks ?? []
    return {
      total: all.filter(t => !t.archived).length,
      doing: all.filter(t => !t.archived && t.completion === 'doing').length,
      todo: all.filter(t => !t.archived && t.completion === 'todo').length,
    }
  }, [data])

  const selectedTask = selected ? (data?.tasks ?? []).find(t => t.uid === selected) : undefined

  /** Pointer-based lane drag: works with mouse and touch (native DnD is touch-blind). */
  const startPointerDrag = useCallback((uid: string, fromLane: string) => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragUid(uid)
    const laneAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null
      return (el?.closest('[data-lane]') as HTMLElement | null)?.dataset.lane ?? null
    }
    const move = (ev: PointerEvent) => setOverLane(laneAt(ev.clientX, ev.clientY))
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const target = laneAt(ev.clientX, ev.clientY)
      setDragUid(null)
      setOverLane(null)
      if (target && target !== fromLane) updatePlanning(uid, { laneOverride: target })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [updatePlanning])

  const renderCard = (task: TaskFact, drag?: { laneId: string }) => (
    <TaskCard
      key={task.uid}
      task={task}
      entry={planning[task.uid]}
      sessions={sessionRefs[task.uid] ?? []}
      focused={isFocused(task.uid, planning)}
      showProvider={showProvider}
      draggable={!!drag}
      dragging={dragUid === task.uid}
      onDragHandle={drag ? startPointerDrag(task.uid, drag.laneId) : undefined}
      onOpen={() => openTask(task.uid)}
      onTogglePin={() => togglePin(task.uid)}
      onOpenSession={pid => navigate(`/live-sessions/${pid}`)}
    />
  )

  const byCompletion = (c: TaskFact['completion']) => unfocused.filter(t => t.kind !== 'epic' && t.completion === c)

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <h1 className="text-lg font-bold text-text-strong">Tasks</h1>
        <span className="text-body-s text-muted">
          {stats.total} 活跃 · {stats.doing} 进行中 · {stats.todo} 待办
        </span>
        <span className="flex-1" />
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          {(['execute', 'survey'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 text-body-s ${view === v ? 'bg-accent-subtle text-accent' : 'text-muted hover:bg-bg-hover'}`}
            >
              {v === 'execute' ? '执行' : '鸟瞰'}
            </button>
          ))}
        </div>
        {writable && (
          <button onClick={() => setCreating(v => !v)} className="px-3 py-1 rounded-md text-body-s font-medium bg-accent text-accent-fg hover:opacity-90" title="记一条临时任务（等谁 / follow up / 下一步）">＋ 临时任务</button>
        )}
        <button onClick={load} className="px-2.5 py-1 text-body-s text-muted hover:text-text rounded-md hover:bg-bg-hover border border-border">刷新</button>
      </div>

      {creating && (
        <div className="mb-3 flex items-center gap-2">
          <input
            autoFocus
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
            placeholder="记一条临时任务：等谁 / follow up / 下一步…"
            className="flex-1 bg-bg-elevated border border-border rounded-md px-2.5 py-2 text-body-s text-text placeholder:text-muted"
          />
          <button onClick={handleCreate} className="px-3 py-2 rounded-md text-body-s bg-accent text-accent-fg">保存</button>
          <button onClick={() => setCreating(false)} className="px-3 py-2 rounded-md text-body-s text-muted hover:bg-bg-hover border border-border">取消</button>
        </div>
      )}

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-danger-subtle text-danger text-body-s flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-2xs">✕</button>
        </div>
      )}
      {data?.warnings?.map((w, i) => (
        <div key={i} className="mb-2 px-3 py-1.5 rounded-md bg-warn-subtle text-warn text-2xs">{w}</div>
      ))}

      {focused.length > 0 && (
        <div className="mb-4">
          <div className="text-meta font-medium text-muted mb-1.5">★ 聚焦</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {focused.map(t => (
              <button
                key={t.uid}
                onClick={() => openTask(t.uid)}
                className="shrink-0 max-w-[240px] text-left bg-accent-subtle border border-accent/25 rounded-md px-2.5 py-1.5 hover:border-accent/50"
              >
                <div className="font-mono text-2xs text-accent">{t.id}</div>
                <div className="text-body-s text-text-strong truncate">{t.title}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mb-4">
        {STATUS_CHIPS.map(c => (
          <button
            key={c.id}
            onClick={() => setStatus(c.id)}
            className={`px-2.5 py-1 rounded-md text-body-s border ${status === c.id ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border text-muted hover:bg-bg-hover'}`}
          >
            {c.label}
          </button>
        ))}
        <span className="flex-1" />
        {showProvider && (
          <select
            value={providerFilter}
            onChange={e => setProviderFilter(e.target.value)}
            className="bg-bg-elevated border border-border rounded-md px-2 py-1 text-body-s text-text"
          >
            <option value="all">全部来源</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? '' : '（不可用）'}</option>)}
          </select>
        )}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索标题 / ID"
          className="w-44 bg-bg-elevated border border-border rounded-md px-2.5 py-1 text-body-s text-text placeholder:text-muted"
        />
      </div>

      {loading ? (
        <div className="grid gap-2 md:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-bg-elevated animate-shimmer" style={{ backgroundImage: 'linear-gradient(90deg, transparent, var(--bg-hover), transparent)', backgroundSize: '200% 100%' }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center text-muted">
          <div className="text-3xl mb-2">🗂️</div>
          <div className="text-body-s">没有匹配的任务</div>
          {writable && <div className="text-2xs mt-1">点右上角「＋ 临时任务」记一条</div>}
          {providers.every(p => p.type === 'local') && (
            <div className="text-2xs mt-1">未发现任务日志源；可在 <span className="font-mono">~/.pi/dashboard.json</span> 配置 journal 路径</div>
          )}
        </div>
      ) : view !== 'survey' ? (
        <div className="grid gap-5">
          <CollapsibleGroup title="进行中" items={byCompletion('doing').map(t => renderCard(t))} />
          <CollapsibleGroup title="待办" items={byCompletion('todo').map(t => renderCard(t))} />
          <CollapsibleGroup title="暂停 / 阻塞" items={byCompletion('paused').map(t => renderCard(t))} />
          <CollapsibleGroup title="已完成" items={byCompletion('done').map(t => renderCard(t))} />
        </div>
      ) : (
        <div className="grid gap-4">
          <TrendPanel points={history} />
          <div className="grid gap-4 md:grid-cols-3">
            {[...lanes.map(l => l.id), 'uncategorized'].map(laneId => {
              const label = lanes.find(l => l.id === laneId)?.label ?? '未分类'
              const items = filtered.filter(t => laneOf(t, lanes, planning) === laneId)
              return (
                <CollapsibleGroup
                  key={laneId}
                  title={label}
                  items={items.map(t => renderCard(t, { laneId }))}
                  limit={25}
                  laneId={laneId}
                  highlight={overLane === laneId}
                  onDrop={uid => updatePlanning(uid, { laneOverride: laneId })}
                />
              )
            })}
          </div>
        </div>
      )}

      {writable && !creating && (
        <button
          onClick={() => setCreating(true)}
          className="md:hidden fixed bottom-20 right-4 z-30 w-12 h-12 rounded-full bg-accent text-accent-fg shadow-lg text-2xl grid place-items-center"
          aria-label="记一条临时任务"
        >＋</button>
      )}

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          entry={planning[selectedTask.uid]}
          sessions={sessionRefs[selectedTask.uid] ?? []}
          lanes={lanes}
          planning={planning}
          authReady={authReady}
          liveOptions={liveOptions}
          onClose={closeDrawer}
          onUpdate={updatePlanning}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onStart={startSession}
          onOpenSession={pid => navigate(`/live-sessions/${pid}`)}
        />
      )}
    </div>
  )
}
