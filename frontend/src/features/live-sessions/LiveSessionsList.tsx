import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LiveSessionGroup, LiveSessionSummary } from '@shared/live-sessions'
import { displayWorktreePath } from '../../utils/displayPath'
import { api } from '../../api/client'
import type { ModelLike } from '../../utils/modelUtils'
import { modelFullId, modelLabel } from '../../utils/modelUtils'
import { SearchInput } from '../../components/ui'
import { TagChip, TagEditor, RowMenu, type RowMenuItem } from '../../components/sessionMetaUi'
import { relTime, projectName } from '../../pages/chat/sessionMeta'
import { liveSessionApi } from './api'
import type { SubagentTaskStatus } from './sessionTitle'
import { useLiveSessionMeta } from './useLiveSessionMeta'

interface LiveSessionsListProps {
  sessions: LiveSessionSummary[]
  sessionTitles?: Record<string, string>
  subagentStatuses?: Record<string, SubagentTaskStatus>
  activeId?: string
  onRefresh?: () => Promise<void>
  onSelect: (processInstanceId: string) => void
}

const PINNED_SECTION = '置顶'
const MAX_TAG_CHIPS = 2
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function statusLabel(status: LiveSessionSummary['status']): string {
  if (status === 'idle') return '等待输入'
  if (status === 'running') return '工作中'
  return '重连中'
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
  return [...items].sort((left, right) => left.startedAt - right.startedAt || left.processInstanceId.localeCompare(right.processInstanceId))
}

function isSubagent(session: LiveSessionSummary): boolean {
  return session.role === 'subagent' || !!session.parentSessionId
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId
}

function sessionTitle(session: LiveSessionSummary, titles: Record<string, string> = {}): string {
  if (titles[session.processInstanceId]) return titles[session.processInstanceId]
  if (session.sessionName) return session.sessionName
  if (isSubagent(session)) return session.subagentWorkId ? `子 Agent · ${session.subagentWorkId.slice(-12)}` : `子 Agent · pi ${session.pid}`
  return `pi ${session.pid}`
}

/** Primary status glyph — the user reads these at a glance faster than text.
 *  The 2px color rail stays as the peripheral-vision cue; the dot is dropped. */
function sessionStatusEmoji(status: LiveSessionSummary['status']): string {
  if (status === 'running') return '🔨'
  if (status === 'reconnecting') return '🔄'
  return '💤'
}

function taskStatusEmoji(status?: SubagentTaskStatus): string {
  if (status === 'queued') return '⏳'
  if (status === 'running') return '🔨'
  if (status === 'completed') return '✅'
  if (status === 'failed') return '⚠️'
  if (status === 'killed' || status === 'cancelled') return '⛔'
  return '❔'
}

/** `idle` is the resting state of a live Pi, so the rail stays quiet; it only
 *  lights up for work in flight or a connection that is coming back. */
function statusTone(session: LiveSessionSummary): 'running' | 'reconnecting' | 'idle' {
  if (session.status === 'running') return 'running'
  if (session.status === 'reconnecting') return 'reconnecting'
  return 'idle'
}

interface RowProps {
  session: LiveSessionSummary
  title: string
  depth: number
  active: boolean
  groupName?: string
  childCount: number
  subagent: boolean
  taskStatus?: SubagentTaskStatus
  tags: string[]
  pinned: boolean
  tagFilter: string | null
  allTags: string[]
  groups: LiveSessionGroup[]
  up: boolean
  busy: boolean
  onSelect: () => void
  onToggleTagFilter: (tag: string) => void
  onPin: (pinned: boolean) => void
  onTags: (tags: string[]) => void
  onRename: (name: string) => void
  onJoinGroup: (groupId: string) => void
  onLeaveGroup: (groupId: string) => void
  onCopySessionId: () => void
}

function SessionRow(p: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [tagEditing, setTagEditing] = useState(false)
  const [renameValue, setRenameValue] = useState(p.title)

  const tone = statusTone(p.session)
  const chips = p.tags.slice(0, MAX_TAG_CHIPS)
  const extra = p.tags.length - chips.length
  const cwd = p.session.canonicalCwd || p.session.cwd
  const branch = p.session.git?.branch

  const groupItems: RowMenuItem[] = p.groups.slice(0, 6).map(g => (g.name === p.groupName
    ? { label: `⇤ 移出「${g.name}」`, onClick: () => p.onLeaveGroup(g.id) }
    : { label: `→ 加入「${g.name}」`, onClick: () => p.onJoinGroup(g.id) }))

  const items: RowMenuItem[] = [
    { label: '✎ 重命名', onClick: () => { setRenameValue(p.title); setRenaming(true) } },
    { label: '🏷 标签', onClick: () => setTagEditing(true) },
    { separator: true },
    { label: p.pinned ? '📌 取消置顶' : '📌 置顶', onClick: () => p.onPin(!p.pinned) },
    ...(groupItems.length ? [{ separator: true } as RowMenuItem] : []),
    ...groupItems,
    { separator: true },
    { label: '⧉ 复制 Session ID', hint: `${shortSessionId(p.session.sessionId)} · pid ${p.session.pid}`, onClick: p.onCopySessionId },
  ]

  const submitRename = (commit: boolean) => {
    const value = renameValue.trim()
    setRenaming(false)
    if (commit && value && value !== p.title) p.onRename(value)
  }

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={0}
        aria-current={p.active || undefined}
        data-pidash-live-status={tone}
        title={`${p.title}\n${cwd}${branch ? ` · ${branch}` : ''}`}
        onMouseDown={e => e.preventDefault()}
        onClick={p.onSelect}
        onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect() } }}
        className={`group flex cursor-pointer gap-2 rounded-md px-1.5 py-1.5 transition-colors ${p.depth ? 'ml-4' : ''} ${p.active ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
      >
        <span className={`w-[2px] shrink-0 self-stretch rounded-full ${
          tone === 'running' ? 'bg-accent shadow-[0_0_7px_var(--accent-glow)]'
            : tone === 'reconnecting' ? 'bg-warn' : 'bg-transparent'
        }`} />
        <div className="min-w-0 flex-1">
          {/* line 1 — title */}
          <div className="flex h-[18px] items-center gap-1.5">
            <span
              className="shrink-0 text-[13px] leading-none"
              role="status"
              aria-label={`Session 状态：${statusLabel(p.session.status)}`}
              title={`${sessionStatusEmoji(p.session.status)} ${statusLabel(p.session.status)}`}
            >{sessionStatusEmoji(p.session.status)}</span>
            {p.depth > 0 && <span className="shrink-0 text-[10px] leading-none text-accent">↳</span>}
            {renaming ? (
              <input
                autoFocus
                aria-label="重命名 Live session"
                value={renameValue}
                maxLength={120}
                onChange={e => setRenameValue(e.target.value)}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                onBlur={() => submitRename(true)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); submitRename(true) }
                  else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false) }
                }}
                className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[13px] text-text-strong outline-none"
              />
            ) : (
              <span className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] ${tone === 'idle' && !p.active ? 'text-text' : 'text-text-strong'}`}>{p.title}</span>
            )}
            {p.childCount > 0 && <span className="shrink-0 rounded bg-bg px-1 text-[9px] leading-[14px] text-muted" title={`${p.childCount} 个子 Agent`}>{p.childCount} 子</span>}
            {p.session.claim.state === 'claimed' && <span className="shrink-0 text-[10px] leading-none" title="已被其他浏览器接管">🔒</span>}
            <span className={`shrink-0 font-mono text-[10px] leading-none text-muted-strong ${menuOpen ? 'invisible' : ''}`} title={`最近活动：${new Date(p.session.lastActivityAt).toLocaleString()}`}>{relTime(p.session.lastActivityAt)}</span>
            <button
              type="button"
              aria-label="Session menu"
              onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
              onClick={() => setMenuOpen(v => !v)}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-[13px] leading-none text-muted transition-opacity hover:bg-bg-elevated hover:text-text-strong ${menuOpen ? 'bg-bg-elevated text-text-strong opacity-100' : 'opacity-50 group-hover:opacity-100 md:opacity-0'}`}
            >⋯</button>
          </div>

          {/* line 2 — status · tags · group · location */}
          <div className="flex h-[16px] items-center gap-1 overflow-hidden">
            {p.pinned && <span className="shrink-0 text-[9px] leading-none text-accent" title="已置顶">📌</span>}
            {p.subagent
              ? <span className={`shrink-0 text-[10px] leading-none ${taskStatusClass(p.taskStatus)}`} title={`子 Agent 任务：${taskStatusLabel(p.taskStatus)}`}>{taskStatusEmoji(p.taskStatus)} 子 Agent · {taskStatusLabel(p.taskStatus)}</span>
              : <span className={`shrink-0 text-[10px] leading-none ${tone === 'running' ? 'text-accent' : tone === 'reconnecting' ? 'text-warn' : 'text-muted-strong'}`}>{statusLabel(p.session.status)}</span>}
            {chips.map(t => <TagChip key={t} tag={t} active={p.tagFilter === t} onClick={p.onToggleTagFilter} />)}
            {extra > 0 && <span className="shrink-0 rounded-full bg-bg-hover px-1 text-[9px] font-semibold leading-[14px] text-muted-strong" title={p.tags.join(', ')}>+{extra}</span>}
            {p.groupName && <span className="shrink-0 truncate text-[10px] leading-none text-ok" title={`任务分组：${p.groupName}`}>{p.groupName}</span>}
            <span className="ml-auto flex min-w-0 shrink items-center gap-1 text-[10px] leading-none text-muted-strong">
              {branch && <span className="shrink-0 truncate" title={`分支：${branch}`}>{branch}</span>}
              <span className="min-w-0 truncate font-mono" title={cwd}>{projectName(cwd) || displayWorktreePath(cwd)}</span>
            </span>
          </div>
        </div>
      </div>

      {tagEditing && <TagEditor tags={p.tags} allTags={p.allTags} onTags={p.onTags} onClose={() => setTagEditing(false)} />}
      {menuOpen && <RowMenu items={items} up={p.up} ariaLabel={`Session actions for ${p.title}`} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

interface Section {
  id: string
  name: string
  group?: LiveSessionGroup
  pinnedSection?: boolean
  sessions: LiveSessionSummary[]
}

export default function LiveSessionsList({ sessions, sessionTitles = {}, subagentStatuses = {}, activeId, onSelect, onRefresh }: LiveSessionsListProps) {
  const [groups, setGroups] = useState<LiveSessionGroup[]>([])
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [starting, setStarting] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [startCwd, setStartCwd] = useState('')
  const [startModel, setStartModel] = useState('')
  const [startModels, setStartModels] = useState<(ModelLike & { contextWindow?: number })[]>([])
  const [startModelsLoading, setStartModelsLoading] = useState(false)
  const [startModelsError, setStartModelsError] = useState<string>()
  const [startTitle, setStartTitle] = useState('')
  const [startThinking, setStartThinking] = useState('max')
  const [startError, setStartError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [armedGroup, setArmedGroup] = useState<string | null>(null)
  const { meta, allTags, tagCounts, patch, refresh: refreshMeta, error: metaError } = useLiveSessionMeta()

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await liveSessionApi.listGroups())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => { void refreshGroups() }, [refreshGroups])

  useEffect(() => {
    if (!startOpen || startModels.length > 0 || startModelsLoading) return
    setStartModelsLoading(true)
    setStartModelsError(undefined)
    api.models().then(result => {
      const models = Array.isArray(result.models) ? result.models as (ModelLike & { contextWindow?: number })[] : []
      setStartModels(models)
    }).catch(reason => {
      setStartModelsError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => setStartModelsLoading(false))
  }, [startOpen, startModels.length, startModelsLoading])

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

  const groupOf = useCallback((session: LiveSessionSummary): LiveSessionGroup | undefined =>
    groups.find(group => group.sessionIds.includes(session.sessionId)), [groups])

  const childrenByParent = useMemo(() => {
    const map = new Map<string, number>()
    for (const session of sessions) {
      if (!session.parentSessionId) continue
      map.set(session.parentSessionId, (map.get(session.parentSessionId) || 0) + 1)
    }
    return map
  }, [sessions])

  /** Search + tag filter, applied before sectioning so counts stay honest. */
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return sessions.filter(session => {
      const entry = meta[session.sessionId]
      if (tagFilter && !(entry?.tags || []).includes(tagFilter)) return false
      if (!q) return true
      return [
        sessionTitle(session, sessionTitles), session.pid, session.sessionId,
        session.canonicalCwd, session.git?.branch || '', (entry?.tags || []).join(' '),
        groupOf(session)?.name || '',
      ].join(' ').toLowerCase().includes(q)
    })
  }, [sessions, meta, sessionTitles, filter, tagFilter, groupOf])

  const sections = useMemo<Section[]>(() => {
    const main = visible.filter(session => !isSubagent(session))
    const pinned = main.filter(session => meta[session.sessionId]?.pinned)
    const pinnedIds = new Set(pinned.map(session => session.processInstanceId))
    const rest = main.filter(session => !pinnedIds.has(session.processInstanceId))
    const out: Section[] = []
    if (pinned.length) out.push({ id: '__pinned', name: PINNED_SECTION, pinnedSection: true, sessions: sortSessions(pinned) })
    for (const group of groups) {
      out.push({ id: group.id, name: group.name, group, sessions: sortSessions(rest.filter(session => group.sessionIds.includes(session.sessionId))) })
    }
    out.push({ id: '__ungrouped', name: '未分组', sessions: sortSessions(rest.filter(session => !groupOf(session))) })
    return out
      .filter(section => section.sessions.length > 0)
      .sort((left, right) => {
        if (left.pinnedSection !== right.pinnedSection) return left.pinnedSection ? -1 : 1
        const leftStarted = left.sessions.length ? Math.min(...left.sessions.map(session => session.startedAt)) : Number.MAX_SAFE_INTEGER
        const rightStarted = right.sessions.length ? Math.min(...right.sessions.map(session => session.startedAt)) : Number.MAX_SAFE_INTEGER
        return leftStarted - rightStarted || left.name.localeCompare(right.name)
      })
  }, [visible, groups, meta, groupOf])

  const groupSummary = (items: LiveSessionSummary[]): string => {
    const waiting = items.filter(session => session.status === 'idle').length
    const working = items.filter(session => session.status === 'running').length
    const reconnecting = items.filter(session => session.status === 'reconnecting').length
    return [waiting ? `${waiting} 等待` : '', working ? `${working} 工作` : '', reconnecting ? `${reconnecting} 重连` : ''].filter(Boolean).join(' · ') || '暂无在线 session'
  }

  const rowHandlers = (session: LiveSessionSummary) => ({
    onPin: (pinned: boolean) => void patch(session.processInstanceId, session.sessionId, { pinned }),
    onTags: (tags: string[]) => void patch(session.processInstanceId, session.sessionId, { tags }),
    onRename: (name: string) => { void liveSessionApi.rename(session.processInstanceId, name).then(() => onRefresh?.()) },
    onJoinGroup: (groupId: string) => void mutateGroups(() => liveSessionApi.addGroupMember(groupId, session.processInstanceId)),
    onLeaveGroup: (groupId: string) => void mutateGroups(() => liveSessionApi.removeGroupMember(groupId, session.sessionId)),
    onCopySessionId: () => { void navigator.clipboard?.writeText(session.sessionId).catch(() => {}) },
  })

  const renderRows = (items: LiveSessionSummary[]) => items.map((session, index) => {
    const group = groupOf(session)
    const subagent = isSubagent(session)
    return (
      <SessionRow
        key={session.processInstanceId}
        session={session}
        title={sessionTitle(session, sessionTitles)}
        depth={0}
        active={activeId === session.processInstanceId}
        groupName={group?.name}
        childCount={childrenByParent.get(session.sessionId) || 0}
        subagent={subagent}
        taskStatus={subagent && session.subagentWorkId ? subagentStatuses[session.subagentWorkId] : undefined}
        tags={meta[session.sessionId]?.tags || []}
        pinned={!!meta[session.sessionId]?.pinned}
        tagFilter={tagFilter}
        allTags={allTags}
        groups={groups}
        up={index >= items.length - 2}
        busy={busy}
        onSelect={() => onSelect(session.processInstanceId)}
        onToggleTagFilter={tag => setTagFilter(current => current === tag ? null : tag)}
        {...rowHandlers(session)}
      />
    )
  })

  return (
    <aside className="pidash-sidebar flex w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-accent md:w-[320px]">
      <div className="sticky top-0 z-10 border-b border-border bg-bg-accent px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-[12px] font-semibold uppercase tracking-[.05em] text-muted">
            Live Pi Sessions
            <span className="ml-1.5 font-mono text-[10px] normal-case tracking-normal text-muted-strong">
              {visible.length === sessions.length ? sessions.length : `${visible.length}/${sessions.length}`}
            </span>
          </div>
          <button type="button" disabled={busy || starting} onClick={() => setStartOpen(value => !value)} className="shrink-0 rounded-md border border-border bg-bg px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-50" title="启动一个新的 Live Pi">＋启动</button>
          <button type="button" disabled={busy || starting} onClick={() => setCreating(value => !value)} className="shrink-0 rounded-md border border-border bg-bg px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-50" title="新建任务分组">＋任务</button>
        </div>

        <div className="mt-2"><SearchInput placeholder="搜索 session / 目录 / 标签…" value={filter} onChange={e => setFilter(e.target.value)} /></div>

        {tagCounts.length > 0 && (
          <div className="mt-1.5 flex items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" onClick={() => setTagFilter(null)}
              className={`shrink-0 rounded-full border px-2 py-px text-[10px] font-semibold leading-[16px] ${!tagFilter ? 'border-border-strong bg-bg-hover text-text-strong' : 'border-transparent text-muted hover:text-text'}`}>全部</button>
            {tagCounts.slice(0, 12).map(({ tag, count }) => (
              <TagChip key={tag} tag={tag} active={tagFilter === tag} onClick={t => setTagFilter(current => current === t ? null : t)} title={`#${tag} · ${count} 个 session`} />
            ))}
          </div>
        )}

        {(startOpen || creating) && <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg p-2">
          {startOpen && <form onSubmit={event => { void startLivePi(event) }} className="space-y-1.5">
            <div className="text-[10px] font-semibold text-accent">启动 Live Pi</div>
            <input autoFocus value={startCwd} onChange={event => setStartCwd(event.target.value)} placeholder="工作目录，例如 /mnt/workspace/lilong/repos/..." className="w-full rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            <select value={startModel} onChange={event => setStartModel(event.target.value)} disabled={startModelsLoading} className="w-full rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none disabled:opacity-60" title="选择启动模型">
              <option value="">{startModelsLoading ? '读取模型列表…' : '默认模型'}</option>
              {startModels.map(model => <option key={modelFullId(model)} value={modelFullId(model)}>{modelLabel(model)} · {modelFullId(model)}</option>)}
            </select>
            {startModelsError && <div className="text-[10px] text-warn">模型列表读取失败，将使用默认模型</div>}
            <div className="flex gap-1.5">
              <select value={startThinking} onChange={event => setStartThinking(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-1 text-[11px] text-text outline-none">
                {THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
              </select>
              <input value={startTitle} onChange={event => setStartTitle(event.target.value)} placeholder="标题（可选）" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            </div>
            <div className="flex gap-1">
              <button type="submit" disabled={starting || !startCwd.trim()} className="flex-1 rounded bg-accent px-2 py-1 text-[11px] text-white disabled:opacity-50">{starting ? '启动中…' : '启动'}</button>
              <button type="button" disabled={starting} onClick={() => setStartOpen(false)} className="rounded border border-border px-2 py-1 text-[11px] text-muted">取消</button>
            </div>
            {startError && <div className="text-[10px] text-danger">启动失败：{startError}</div>}
          </form>}
          {creating && <form onSubmit={event => { void createGroup(event) }} className="flex gap-1 border-t border-border pt-2">
            <input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} placeholder="任务分组名称" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-text outline-none focus:border-accent" />
            <button type="submit" disabled={busy || !newGroupName.trim()} className="rounded border border-border px-2 py-1 text-[11px] text-muted disabled:opacity-50">创建</button>
          </form>}
        </div>}

        {error && <div className="mt-2 text-[11px] text-danger">分组同步失败：{error}</div>}
        {tagFilter && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-strong">
            仅显示 <TagChip tag={tagFilter} active /> 的 session
            <button type="button" className="underline hover:text-text" onClick={() => setTagFilter(null)}>清除</button>
          </div>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="p-5 text-sm text-muted">暂无已连接的 Pi session。已运行的 Pi 需要加载集成 Extension。</div>
      ) : sections.length === 0 ? (
        <div className="p-5 text-[12px] text-muted-strong">没有匹配的 session{filter || tagFilter ? '（清除筛选试试）' : ''}</div>
      ) : sections.map(section => (
        <section key={section.id} className="border-b border-border/60">
          <div className="flex items-center gap-1 px-2.5 pb-1 pt-2">
            <span className={`text-[8px] transition-transform ${section.pinnedSection ? 'text-accent' : 'text-muted-strong'}`}>▾</span>
            {section.pinnedSection && <span className="text-[9px] leading-none text-accent">📌</span>}
            {renamingGroup === section.id ? (
              <input
                autoFocus
                aria-label="重命名任务分组"
                value={groupDraft}
                maxLength={120}
                onChange={e => setGroupDraft(e.target.value)}
                onBlur={() => { setRenamingGroup(null); const name = groupDraft.trim(); if (name && name !== section.name) void mutateGroups(() => liveSessionApi.renameGroup(section.id, name)) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
                  else if (e.key === 'Escape') { e.preventDefault(); setRenamingGroup(null) }
                }}
                className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-[12px] text-text-strong outline-none"
              />
            ) : (
              <strong className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[.06em] text-text-strong" title={section.name}>{section.name}</strong>
            )}
            <span className="shrink-0 font-mono text-[10px] text-muted-strong">{section.sessions.length}</span>
            {section.group && <>
              <button type="button" disabled={busy} aria-label="重命名任务分组按钮" onClick={() => { setRenamingGroup(section.id); setGroupDraft(section.name) }} className="rounded px-1 text-[11px] text-muted hover:bg-bg-hover hover:text-accent" title="重命名任务">✎</button>
              <button
                type="button"
                disabled={busy}
                aria-label="删除任务分组"
                onClick={() => {
                  if (armedGroup === section.id) { setArmedGroup(null); void mutateGroups(() => liveSessionApi.deleteGroup(section.id!)) }
                  else setArmedGroup(section.id)
                }}
                className={`shrink-0 rounded px-1 text-[10px] ${armedGroup === section.id ? 'bg-danger-subtle font-semibold text-danger' : 'text-muted hover:bg-danger-subtle hover:text-danger'}`}
                title={armedGroup === section.id ? '再点一次确认删除（session 不会被删除）' : '删除任务分组'}
              >{armedGroup === section.id ? '确认删除' : '×'}</button>
            </>}
          </div>
          <div className="px-2.5 pb-1 text-[10px] text-muted-strong">{section.group || section.pinnedSection ? groupSummary(section.sessions) : `${section.sessions.length} 个 session`}</div>
          <div className="pb-1.5">{renderRows(section.sessions)}</div>
        </section>
      ))}

      <div className="px-3 py-2 text-[10px] text-muted-strong">
        悬停 session 点 ⋯：重命名 / 标签 / 置顶 / 加入任务
        {metaError !== undefined && <button type="button" className="ml-1 text-danger underline" onClick={() => void refreshMeta()}>· 标签同步失败，点击重试</button>}
      </div>
    </aside>
  )
}
