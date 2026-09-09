import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { LiveSessionSummary } from '@shared/live-sessions'
import { useAppDispatch, useAppSelector } from '../../store'
import { authenticated } from '../../store/liveSessionsSlice'
import { buildSessionTitles } from './sessionTitle'
import { AuthPanel } from './LiveSessionPage'
import { useLiveSessionsRuntime } from './useLiveSessions'

function statusLabel(status: LiveSessionSummary['status']): string {
  if (status === 'idle') return '等待输入'
  if (status === 'running') return '工作中'
  return '重连中'
}

function statusClass(status: LiveSessionSummary['status']): string {
  if (status === 'idle') return 'border-border text-muted'
  if (status === 'running') return 'border-accent/50 bg-accent-subtle text-accent'
  return 'border-warn/50 bg-warn/10 text-warn'
}

export default function LiveSessionGalleryPage() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const { refresh } = useLiveSessionsRuntime()
  const state = useAppSelector(root => root.liveSessions)
  const [filter, setFilter] = useState<'all' | LiveSessionSummary['status']>('all')
  const [query, setQuery] = useState('')
  const titles = useMemo(() => buildSessionTitles(state.sessions, state.details), [state.sessions, state.details])
  const sessions = useMemo(() => Object.values(state.sessions)
    .filter(session => filter === 'all' || session.status === filter)
    .filter(session => {
      const text = `${titles[session.processInstanceId] || session.sessionName || ''} ${session.canonicalCwd} ${session.pid}`.toLowerCase()
      return !query.trim() || text.includes(query.trim().toLowerCase())
    })
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt), [filter, query, state.sessions, titles])

  if (state.auth === 'checking') return <div className="flex flex-1 items-center justify-center text-muted">检查 Live Session 认证…</div>
  if (state.auth === 'required') return <AuthPanel onAuthenticated={browserClientId => { dispatch(authenticated({ browserClientId })); void refresh() }} />

  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg p-4 md:p-6">
    <header className="mb-4 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold text-text-strong">Session Gallery</h1>
        <p className="mt-1 text-xs text-muted">所有 Chat / Live session 的可视化总览；点击卡片进入独立会话。</p>
      </div>
      <button type="button" onClick={() => navigate('/live-sessions')} className="rounded border border-border bg-card px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-accent">返回 Live Pi</button>
    </header>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、路径或 PID" className="min-w-[220px] flex-1 rounded border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent" />
      {(['all', 'idle', 'running', 'reconnecting'] as const).map(value => <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded border px-3 py-1.5 text-xs ${filter === value ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-card text-muted hover:border-accent'}`}>
        {value === 'all' ? '全部' : statusLabel(value)}
      </button>)}
    </div>
    {sessions.length === 0 ? <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted">没有匹配的 session。</div> : <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {sessions.map(session => {
        const subagent = session.role === 'subagent' || !!session.parentSessionId
        return <button key={session.processInstanceId} type="button" onClick={() => navigate(`/live-sessions/${encodeURIComponent(session.processInstanceId)}`)} className="group rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-accent hover:bg-accent-subtle">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-strong" title={titles[session.processInstanceId] || session.sessionName || `Pi ${session.pid}`}>{titles[session.processInstanceId] || session.sessionName || `Pi ${session.pid}`}</span>
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${statusClass(session.status)}`}>{statusLabel(session.status)}</span>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-muted"><span className="rounded bg-bg px-1.5 py-0.5">{subagent ? '子 Agent' : '主 Pi'}</span><span>PID {session.pid}</span><span>{session.mode.toUpperCase()}</span></div>
          <div className="mt-2 truncate text-xs text-muted" title={session.canonicalCwd}>{session.canonicalCwd}</div>
          {session.model && <div className="mt-1 truncate font-mono text-[10px] text-muted/70">{session.model.provider}/{session.model.id}</div>}
          <div className="mt-3 text-[10px] text-accent opacity-0 transition-opacity group-hover:opacity-100">打开会话 →</div>
        </button>
      })}
    </div>}
  </div>
}
