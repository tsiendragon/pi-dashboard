import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LiveSessionGroup, LiveSessionSummary } from '@shared/live-sessions'
import { displayWorktreePath } from '../../utils/displayPath'
import { liveSessionApi } from './api'
import type { SubagentTaskStatus } from './sessionTitle'

interface LiveSessionsListProps {
  sessions: LiveSessionSummary[]
  sessionTitles?: Record<string, string>
  subagentStatuses?: Record<string, SubagentTaskStatus>
  activeId?: string
  onRefresh?: () => Promise<void>
  onSelect: (processInstanceId: string) => void
}

function statusRank(status: LiveSessionSummary['status']): number {
  if (status === 'idle') return 0
  if (status === 'running') return 1
  return 2
}

function statusLabel(status: LiveSessionSummary['status']): string {
  if (status === 'idle') return '等待输入'
  if (status === 'running') return '工作中'
  return '重连中'
}

function statusClass(status: LiveSessionSummary['status']): string {
  if (status === 'idle') return 'bg-muted'
  if (status === 'running') return 'bg-accent animate-pulse'
  return 'bg-warn'
}

function taskStatusLabel(status?: SubagentTaskStatus): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '工作中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'killed') return '已终止'
  if (status === 'cancelled') return '已取消'
  return '未上报'
}

function taskStatusClass(status?: SubagentTaskStatus): string {
  if (status === 'completed') return 'text-ok'
  if (status === 'failed' || status === 'killed' || status === 'cancelled') return 'text-danger'
  if (status === 'running' || status === 'queued') return 'text-accent'
  return 'text-muted'
}

function sortSessions(items: LiveSessionSummary[]): LiveSessionSummary[] {
  return [...items].sort((left, right) => statusRank(left.status) - statusRank(right.status) || right.lastActivityAt - left.lastActivityAt)
}

function isSubagent(session: LiveSessionSummary): boolean {
  return session.role === 'subagent' || !!session.parentSessionId
}

function sessionTitle(session: LiveSessionSummary, titles: Record<string, string> = {}): string {
  if (titles[session.processInstanceId]) return titles[session.processInstanceId]
  if (session.sessionName) return session.sessionName
  if (isSubagent(session)) return session.subagentWorkId ? `子 Agent · ${session.subagentWorkId.slice(-12)}` : `子 Agent · pi ${session.pid}`
  return `pi ${session.pid}`
}

export default function LiveSessionsList({ sessions, sessionTitles = {}, subagentStatuses = {}, activeId, onSelect, onRefresh }: LiveSessionsListProps) {
  const [groups, setGroups] = useState<LiveSessionGroup[]>([])
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [starting, setStarting] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [startCwd, setStartCwd] = useState('')
  const [startModel, setStartModel] = useState('')
  const [startTitle, setStartTitle] = useState('')
  const [startThinking, setStartThinking] = useState('max')
  const [startError, setStartError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set())

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await liveSessionApi.listGroups())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => { void refreshGroups() }, [refreshGroups])

  const mutateGroups = useCallback(async (operation: () => Promise<LiveSessionGroup[]>) => {
    setBusy(true)
    setError(undefined)
    try {
      setGroups(await operation())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const createGroup = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!newGroupName.trim()) return
    await mutateGroups(() => liveSessionApi.createGroup(newGroupName.trim()))
    setNewGroupName('')
    setCreating(false)
  }

  const startLivePi = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!startCwd.trim()) return
    setStarting(true)
    setStartError(undefined)
    try {
      await liveSessionApi.start({ cwd: startCwd.trim(), ...(startModel.trim() ? { model: startModel.trim() } : {}), thinkingLevel: startThinking, ...(startTitle.trim() ? { title: startTitle.trim() } : {}) })
      setStartCwd('')
      setStartModel('')
      setStartTitle('')
      setStarting(false)
      setStartOpen(false)
      window.setTimeout(() => { void onRefresh?.() }, 1_000)
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : String(reason))
      setStarting(false)
    }
  }

  const groupBySessionId = useMemo(() => {
    const map = new Map<string, LiveSessionGroup>()
    for (const group of groups) for (const sessionId of group.sessionIds) if (!map.has(sessionId)) map.set(sessionId, group)
    return map
  }, [groups])

  const childrenByParent = useMemo(() => {
    const map = new Map<string, LiveSessionSummary[]>()
    for (const session of sessions) {
      if (!session.parentSessionId) continue
      const children = map.get(session.parentSessionId) || []
      children.push(session)
      map.set(session.parentSessionId, children)
    }
    for (const [parentId, children] of map) map.set(parentId, sortSessions(children))
    return map
  }, [sessions])

  const toggleChildren = (sessionId: string) => {
    setCollapsedParents(previous => {
      const next = new Set(previous)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const sections = useMemo(() => {
    const result: Array<{ id: string; name: string; group?: LiveSessionGroup; sessions: LiveSessionSummary[] }> = groups.map(group => ({
      id: group.id,
      name: group.name,
      group,
      sessions: sortSessions(sessions.filter(session => group.sessionIds.includes(session.sessionId))),
    }))
    result.push({ id: 'ungrouped', name: '未分组', sessions: sortSessions(sessions.filter(session => !groupBySessionId.has(session.sessionId))) })
    return result
      .filter(section => section.group || section.sessions.length > 0)
      .sort((left, right) => {
        const leftRank = left.sessions.length ? Math.min(...left.sessions.map(session => statusRank(session.status))) : 3
        const rightRank = right.sessions.length ? Math.min(...right.sessions.map(session => statusRank(session.status))) : 3
        return leftRank - rightRank || left.name.localeCompare(right.name)
      })
  }, [groups, groupBySessionId, sessions])

  const groupSummary = (items: LiveSessionSummary[]): string => {
    const waiting = items.filter(session => session.status === 'idle').length
    const working = items.filter(session => session.status === 'running').length
    const reconnecting = items.filter(session => session.status === 'reconnecting').length
    return [waiting ? `${waiting} 等待` : '', working ? `${working} 工作` : '', reconnecting ? `${reconnecting} 重连` : ''].filter(Boolean).join(' · ') || '暂无在线 session'
  }

  return (
    <aside className="w-full shrink-0 overflow-y-auto border-r border-border bg-bg-accent md:w-[320px]">
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-sm font-semibold text-text-strong">Live Pi Sessions</div>
          <button type="button" disabled={busy || starting} onClick={() => setStartOpen(value => !value)} className="shrink-0 rounded border border-accent/50 bg-accent-subtle px-2 py-0.5 text-[11px] text-accent hover:border-accent disabled:opacity-50" title="启动一个新的 Live Pi">＋启动 Live</button>
          <button type="button" disabled={busy || starting} onClick={() => setCreating(value => !value)} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-50" title="新建任务分组">＋任务</button>
        </div>
        <div className="mt-1 text-[11px] text-muted">等待输入优先 · 工作中靠后 · 可按任务合并 session</div>
        {(startOpen || creating) && <div className="mt-2 space-y-2 rounded border border-border bg-bg p-2">
          {startOpen && <form onSubmit={event => { void startLivePi(event) }} className="space-y-1.5">
            <div className="text-[10px] font-semibold text-accent">启动 Live Pi</div>
            <input autoFocus value={startCwd} onChange={event => setStartCwd(event.target.value)} placeholder="工作目录，例如 /mnt/workspace/lilong/repos/..." className="w-full rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            <input value={startModel} onChange={event => setStartModel(event.target.value)} placeholder="模型 provider/model（可选）" className="w-full rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            <div className="flex gap-1.5">
              <select value={startThinking} onChange={event => setStartThinking(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-1 text-[11px] text-text outline-none">
                {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level} value={level}>{level}</option>)}
              </select>
              <input value={startTitle} onChange={event => setStartTitle(event.target.value)} placeholder="标题（可选）" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            </div>
            <div className="flex gap-1">
              <button type="submit" disabled={starting || !startCwd.trim()} className="flex-1 rounded bg-accent px-2 py-1 text-[11px] text-white disabled:opacity-50">{starting ? '启动中…' : '启动'}</button>
              <button type="button" disabled={starting} onClick={() => setStartOpen(false)} className="rounded border border-border px-2 py-1 text-[11px] text-muted">取消</button>
            </div>
          </form>}
          {creating && <form onSubmit={event => { void createGroup(event) }} className="flex gap-1 border-t border-border pt-2">
            <input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} placeholder="任务分组名称" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            <button type="submit" disabled={busy || !newGroupName.trim()} className="rounded border border-border px-2 py-1 text-[11px] text-muted disabled:opacity-50">创建任务</button>
          </form>}
          {startOpen && startError && <div className="text-[10px] text-danger">启动失败：{startError}</div>}
        </div>}
        {error && <div className="mt-2 text-[11px] text-danger">分组同步失败：{error}</div>}
      </div>
      {sessions.length === 0 ? (
        <div className="p-5 text-sm text-muted">暂无已连接的 Pi session。已运行的 Pi 需要加载集成 Extension。</div>
      ) : sections.map(section => (
        <section key={section.id} className="border-b border-border/70">
          <div className="border-b border-border/40 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <strong className="min-w-0 flex-1 truncate text-xs text-text-strong" title={section.name}>{section.name}</strong>
              {section.group && <>
                <select
                  disabled={busy || sessions.length === section.sessions.length}
                  defaultValue=""
                  onChange={event => {
                    const processInstanceId = event.target.value
                    event.currentTarget.value = ''
                    if (processInstanceId) void mutateGroups(() => liveSessionApi.addGroupMember(section.group!.id, processInstanceId))
                  }}
                  className="max-w-[92px] rounded border border-border bg-bg px-1 py-0.5 text-[10px] text-muted outline-none"
                  title="把 session 加入此任务"
                  aria-label={`把 session 加入 ${section.name}`}
                >
                  <option value="">＋加入</option>
                  {sessions.filter(session => session.sessionId !== undefined && !section.group!.sessionIds.includes(session.sessionId)).map(session => <option key={session.processInstanceId} value={session.processInstanceId}>{sessionTitle(session, sessionTitles)}</option>)}
                </select>
                <button type="button" disabled={busy} onClick={() => { const name = window.prompt('修改任务名称', section.name); if (name?.trim()) void mutateGroups(() => liveSessionApi.renameGroup(section.group!.id, name)) }} className="rounded px-1 text-[11px] text-muted hover:bg-bg-hover hover:text-accent" title="重命名任务">✎</button>
                <button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除任务分组“${section.name}”？session 不会被删除。`)) void mutateGroups(() => liveSessionApi.deleteGroup(section.group!.id)) }} className="rounded px-1 text-[11px] text-muted hover:bg-danger-subtle hover:text-danger" title="删除任务分组">×</button>
              </>}
            </div>
            <div className="mt-0.5 text-[10px] text-muted">{section.group ? groupSummary(section.sessions) : `${section.sessions.length} 个 session`}</div>
          </div>
          {(() => {
            const sectionIds = new Set(section.sessions.map(session => session.sessionId))
            const roots = sortSessions(section.sessions.filter(session => !session.parentSessionId || !sectionIds.has(session.parentSessionId)))
            const renderSessionTree = (session: LiveSessionSummary, depth: number): React.ReactNode[] => {
              const children = (childrenByParent.get(session.sessionId) || []).filter(child => sectionIds.has(child.sessionId))
              const collapsed = collapsedParents.has(session.sessionId)
              const active = activeId === session.processInstanceId
              const group = groupBySessionId.get(session.sessionId)
              const subagent = isSubagent(session)
              const taskStatus = subagent && session.subagentWorkId ? subagentStatuses[session.subagentWorkId] : undefined
              const row = <div key={session.processInstanceId} className={`flex border-l-2 transition-colors ${depth ? 'ml-4 border-l-accent/30 bg-bg/30' : ''} ${active ? 'border-l-accent bg-accent-subtle' : 'border-l-transparent hover:bg-bg-hover'}`}>
                {children.length ? <button type="button" onClick={() => toggleChildren(session.sessionId)} className="w-6 shrink-0 self-stretch text-[11px] text-muted hover:text-accent" title={collapsed ? '展开子 Agent' : '折叠子 Agent'}>{collapsed ? '▸' : '▾'}</button> : <span className="w-6 shrink-0" />}
                <button type="button" className={`min-w-0 flex-1 bg-transparent px-2 text-left ${depth ? 'py-1.5' : 'py-2.5'}`} onClick={() => onSelect(session.processInstanceId)}>
                  <div className="flex items-center gap-1.5">
                    {depth > 0 && <span className="text-[10px] text-accent">↳</span>}
                    <span className={`h-2 w-2 shrink-0 rounded-full ${statusClass(session.status)}`} />
                    <span className={`shrink-0 rounded px-1 text-[9px] ${subagent ? 'bg-accent/10 text-accent' : 'bg-bg text-muted'}`}>{subagent ? '子 Agent' : '主 Pi'}</span>
                    {children.length > 0 && <span className="shrink-0 rounded bg-bg px-1 text-[9px] text-muted">{children.length} 子 Agent</span>}
                    <span className="min-w-0 flex-1 whitespace-normal break-words text-[12px] font-medium text-text-strong" title={sessionTitle(session, sessionTitles)}>{sessionTitle(session, sessionTitles)}</span>
                    <span className={`shrink-0 text-[10px] ${session.status === 'idle' ? 'text-muted' : session.status === 'running' ? 'text-accent' : 'text-warn'}`}>{statusLabel(session.status)}</span>
                    {session.claim.state === 'claimed' && <span title="已接管">🔒</span>}
                  </div>
                  <div className="mt-1 ml-5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted">
                    {subagent && <span className={`font-sans ${taskStatusClass(taskStatus)}`}>任务：{taskStatusLabel(taskStatus)}</span>}
                    {subagent && <span className="text-muted/60">· session {statusLabel(session.status)}</span>}
                  </div>
                  <div className="mt-0.5 ml-5 truncate text-[10px] text-muted/80" title={session.canonicalCwd}>{displayWorktreePath(session.canonicalCwd)}</div>
                </button>
                {group && <button type="button" disabled={busy} onClick={() => void mutateGroups(() => liveSessionApi.removeGroupMember(group.id, session.sessionId))} className="self-start px-2.5 py-2.5 text-xs text-muted hover:text-danger disabled:opacity-50" title={`从${group.name}移出`}>×</button>}
              </div>
              return [row, ...(collapsed ? [] : children.flatMap(child => renderSessionTree(child, depth + 1)))]
            }
            return roots.flatMap(session => renderSessionTree(session, 0))
          })()}
          {section.group && section.sessions.length === 0 && <div className="px-3 py-2 text-[11px] text-muted">当前没有在线成员；分组仍会保留。</div>}
        </section>
      ))}
    </aside>
  )
}
