import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LiveSessionGroup, LiveSessionReloadResult, LiveSessionSummary } from '@shared/live-sessions'
import { displayWorktreePath } from '../../utils/displayPath'
import { api } from '../../api/client'
import type { ModelLike } from '../../utils/modelUtils'
import { modelFullId, modelLabel } from '../../utils/modelUtils'
import { SearchInput } from '../../components/ui'
import PathCompleteMenu from '../../components/PathCompleteMenu'
import { TagChip, TagEditor, RowMenu, type RowMenuItem } from '../../components/sessionMetaUi'
import MaterialIcon, { type MaterialIconName } from '../../components/MaterialIcon'
import WorkingHammerIcon from '../../components/WorkingHammerIcon'
import { relTime, projectName } from '../../pages/chat/sessionMeta'
import { liveSessionApi } from './api'
import type { SubagentTaskStatus } from './sessionTitle'
import { moveInOrder, materializeOrder, resolveDropTarget, buildSessionSections, groupOfSession, isSubagent, type DropTarget, type SessionSection } from './sessionOrder'
import { useLiveSessionMeta } from './useLiveSessionMeta'
import { useLiveSessionOrder } from './useLiveSessionOrder'

interface LiveSessionsListProps {
  sessions: LiveSessionSummary[]
  sessionTitles?: Record<string, string>
  subagentStatuses?: Record<string, SubagentTaskStatus>
  activeId?: string
  onRefresh?: () => Promise<void>
  /** Unanswered extension dialogs per session — row badge so a blocked agent is visible. */
  pendingUiCounts?: Record<string, number>
  onSelect: (processInstanceId: string) => void
}

const MAX_TAG_CHIPS = 2

/**
 * Launcher failures are accurate but cryptic (`live_pi_registration_timeout:
 * ... was killed after 120000ms without registering`). Translate the ones users
 * actually hit, and keep any Pi pane output the backend attached — that text is
 * the only clue about why the start hung.
 */
function formatStartError(message: string): string {
  const paneTail = message.split('\n').slice(1).join('\n').trim()
  if (message.includes('live_pi_registration_timeout')) {
    const waited = /after (\d+)ms/.exec(message)?.[1]
    const seconds = waited ? Math.round(Number(waited) / 1000) : 120
    const hint = 'Pi 进程没在限时内注册到 dashboard，已清理该 tmux 会话。常见原因：机器上常驻 Pi 会话过多、磁盘冷读导致冷启动变慢，或 Pi 启动即报错。'
    return `${hint}（等待 ${seconds} 秒）${paneTail ? `\n${paneTail}` : ''}`
  }
  if (message.includes('tmux_unavailable')) return 'tmux 不可用（未安装或不在 PATH 上），无法启动 live session。'
  if (message.includes('live_pi_start_failed')) return `无法创建 tmux 会话：${message}`
  if (message.includes('is outside configured roots')) return `该目录不在允许启动 live session 的根目录内：${message}`
  return message
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function statusLabel(status: LiveSessionSummary['status']): string {
  if (status === 'idle') return '等待输入'
  if (status === 'running') return '工作中'
  return '重连中'
}

/** One-line result of a bulk reload, e.g. 「已重载 5 个会话，跳过 2 个子 Agent」. */
function reloadAllSummary(result: LiveSessionReloadResult): string {
  const parts = [`已重载 ${result.reloaded.length} 个会话`]
  if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 个子 Agent`)
  if (result.failed.length > 0) parts.push(`${result.failed.length} 个失败（${result.failed.map(item => item.code).join('、')}）`)
  return parts.join('，')
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

/** Pointer travel before a press becomes a drag; below it a press is still a
 *  plain click, so selecting a row keeps working exactly as before. */
const DRAG_THRESHOLD = 4

/**
 * Row order is manual now (see `sessionOrder.ts`): a row only moves when the
 * user drags it. The old `startedAt` sort lived here and made every row below
 * an exiting session jump up during the workday.
 */

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId
}

function sessionTitle(session: LiveSessionSummary, titles: Record<string, string> = {}): string {
  if (titles[session.processInstanceId]) return titles[session.processInstanceId]
  if (session.sessionName) return session.sessionName
  if (isSubagent(session)) return session.subagentWorkId ? `子 Agent · ${session.subagentWorkId.slice(-12)}` : `子 Agent · pi ${session.pid}`
  return `pi ${session.pid}`
}

/** Subagent task status → Material icon, so the row keeps one glyph language. */
function taskStatusIcon(status?: SubagentTaskStatus): MaterialIconName {
  if (status === 'queued') return 'schedule'
  if (status === 'completed') return 'check'
  if (status === 'failed') return 'error'
  if (status === 'killed' || status === 'cancelled') return 'block'
  return 'remove'
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
  pendingUiCount?: number
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
  /** Start a new independent Pi forked from this session (pi `--fork`). */
  onFork: () => void
  onJoinGroup: (groupId: string) => void
  onLeaveGroup: (groupId: string) => void
  onCopySessionId: () => void
  /** Namespaced tmux session hosting this Pi; absent for externally started ones. */
  tmuxSession?: string
  onCopyTerminalCommand: () => void
  onCloseSession: () => void
  /** Section this row renders in; drop targets are resolved per block. */
  blockId: string
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  onDragStart: (event: React.PointerEvent<HTMLDivElement>) => void
  onMove: (place: 'up' | 'down' | 'top') => void
  /** Position inside its block (0-based) and the block size, for the move menu. */
  moveIndex: number
  moveCount: number
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
    ...(p.subagent ? [] : [{ label: '⑂ 从此分叉', hint: '新建一个独立的 Pi 会话，继承任务分组并排在下方', onClick: p.onFork } as RowMenuItem]),
    { separator: true },
    { label: p.pinned ? '📌 取消置顶' : '📌 置顶', onClick: () => p.onPin(!p.pinned) },
    ...(p.moveCount > 1 ? [{ separator: true } as RowMenuItem] : []),
    ...(p.moveIndex > 0 ? [
      { label: '↑ 上移', onClick: () => p.onMove('up') } as RowMenuItem,
      { label: '⤒ 移到本组顶部', onClick: () => p.onMove('top') } as RowMenuItem,
    ] : []),
    ...(p.moveIndex >= 0 && p.moveIndex < p.moveCount - 1 ? [{ label: '↓ 下移', onClick: () => p.onMove('down') } as RowMenuItem] : []),
    ...(p.tmuxSession ? [
      { separator: true } as RowMenuItem,
      { label: '⧉ 复制终端命令', hint: `tmux attach -t ${p.tmuxSession}`, onClick: p.onCopyTerminalCommand } as RowMenuItem,
      { label: '⏻ 关闭 session（kill tmux）', hint: `${p.tmuxSession} · Pi 进程会一起结束`, confirmLabel: '再点一次确认关闭', danger: true, onClick: p.onCloseSession } as RowMenuItem,
    ] : []),
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
      {p.dropBefore && <div aria-hidden className="pointer-events-none -mb-px h-[2px] rounded-full bg-accent" />}
      <div
        role="button"
        tabIndex={0}
        aria-current={p.active || undefined}
        data-pidash-live-status={tone}
        data-live-row={p.session.sessionId}
        data-live-block={p.blockId}
        title={`${p.title}\n${cwd}${branch ? ` · ${branch}` : ''}`}
        onMouseDown={e => e.preventDefault()}
        onPointerDown={p.onDragStart}
        onClick={p.onSelect}
        onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect() } }}
        className={`group flex cursor-pointer gap-2 rounded-md px-1.5 py-1.5 transition-colors ${p.depth ? 'ml-4' : ''} ${p.dragging ? 'opacity-40' : ''} ${p.active ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
      >
        <span className={`w-[2px] shrink-0 self-stretch rounded-full ${
          tone === 'running' ? 'bg-accent shadow-[0_0_7px_var(--accent-glow)]'
            : tone === 'reconnecting' ? 'bg-warn' : 'bg-transparent'
        }`} />
        {/* status gutter — the running glyph spans both text lines so the swing
            has room; every other status is a quiet dot or a spinner */}
        <span
          className="flex w-[26px] shrink-0 items-stretch justify-center self-stretch text-body-s leading-none"
          role="status"
          aria-label={`Session 状态：${statusLabel(p.session.status)}`}
          data-session-status={p.session.status}
          title={statusLabel(p.session.status)}
        >{p.session.status === 'running'
          ? <span className="flex w-full items-center justify-center"><WorkingHammerIcon className="working-hammer-row" /></span>
          : p.session.status === 'reconnecting'
            ? <span className="flex h-[18px] w-full items-center justify-center text-warn"><MaterialIcon name="sync" spin className="h-4 w-4" /></span>
            : <span className="flex h-[18px] w-full items-center justify-center" aria-hidden="true"><span className="h-[7px] w-[7px] rounded-full border border-muted-strong opacity-60" /></span>}</span>
        <div className="min-w-0 flex-1">
          {/* line 1 — title */}
          <div className="flex h-[18px] items-center gap-1.5">
            {p.depth > 0 && <span className="shrink-0 text-2xs leading-none text-accent">↳</span>}
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
                className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-body-s text-text-strong outline-none"
              />
            ) : (
              <span className={`min-w-0 flex-1 truncate text-body-s leading-[18px] ${tone === 'idle' && !p.active ? 'text-text' : 'text-text-strong'}`}>{p.title}</span>
            )}
            {p.childCount > 0 && <span className="shrink-0 rounded-full bg-bg-hover px-1.5 text-2xs leading-[14px] text-muted" title={`${p.childCount} 个子 Agent`}>{p.childCount} 子</span>}
            {p.session.claim.state === 'claimed' && <span className="flex shrink-0 items-center text-muted-strong" title="已被其他浏览器接管"><MaterialIcon name="lock" className="h-3.5 w-3.5" /></span>}
            <span className={`shrink-0 font-mono text-2xs leading-none text-muted-strong ${menuOpen ? 'invisible' : ''}`} title={`最近活动：${new Date(p.session.lastActivityAt).toLocaleString()}`}>{relTime(p.session.lastActivityAt)}</span>
            <button
              type="button"
              aria-label="Session menu"
              onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
              onClick={() => setMenuOpen(v => !v)}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition-opacity hover:bg-bg-hover hover:text-text-strong ${menuOpen ? 'bg-bg-hover text-text-strong opacity-100' : 'opacity-50 group-hover:opacity-100 md:opacity-0'}`}
            ><MaterialIcon name="more_horiz" className="h-4 w-4" /></button>
          </div>

          {/* line 2 — status · tags · group · location */}
          <div className="flex h-[16px] items-center gap-1 overflow-hidden">
            {p.pinned && <span className="flex shrink-0 items-center text-accent" title="已置顶"><MaterialIcon name="push_pin" className="h-3.5 w-3.5" /></span>}
            {p.tmuxSession && <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-bg px-1.5 text-2xs leading-[14px] text-muted-strong" title={`终端可访问：tmux attach -t ${p.tmuxSession}`}><MaterialIcon name="terminal" className="h-3 w-3" />终端</span>}
            {p.subagent
              ? <span className={`inline-flex shrink-0 items-center gap-0.5 text-2xs leading-none ${taskStatusClass(p.taskStatus)}`} title={`子 Agent 任务：${taskStatusLabel(p.taskStatus)}`}>{p.taskStatus === 'running' ? <WorkingHammerIcon className="h-3 w-3" /> : <MaterialIcon name={taskStatusIcon(p.taskStatus)} className="h-3.5 w-3.5" />}子 Agent · {taskStatusLabel(p.taskStatus)}</span>
              : <span className={`shrink-0 text-2xs leading-none ${tone === 'running' ? 'text-accent' : tone === 'reconnecting' ? 'text-warn' : 'text-muted-strong'}`}>{statusLabel(p.session.status)}</span>}
            {(p.pendingUiCount ?? 0) > 0 && <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warn-subtle px-1.5 text-2xs leading-[14px] text-warn" title={`该会话有 ${p.pendingUiCount} 个待应答请求，agent 正在等待回答`}><MaterialIcon name="error" className="h-3 w-3" />待应答 {p.pendingUiCount}</span>}
            {chips.map(t => <TagChip key={t} tag={t} active={p.tagFilter === t} onClick={p.onToggleTagFilter} />)}
            {extra > 0 && <span className="shrink-0 rounded-full bg-bg-hover px-1 text-2xs font-semibold leading-[14px] text-muted-strong" title={p.tags.join(', ')}>+{extra}</span>}
            {p.groupName && <span className="shrink-0 truncate rounded-full bg-ok-subtle px-1.5 text-2xs leading-[14px] text-ok" title={`任务分组：${p.groupName}`}>{p.groupName}</span>}
            <span className="ml-auto flex min-w-0 shrink items-center gap-1 text-2xs leading-none text-muted-strong">
              {branch && <span className="shrink-0 truncate" title={`分支：${branch}`}>{branch}</span>}
              {branch && <span className="shrink-0 text-muted-strong opacity-40" aria-hidden="true">·</span>}
              <span className="min-w-0 truncate font-mono" title={cwd}>{projectName(cwd) || displayWorktreePath(cwd)}</span>
            </span>
          </div>
        </div>
      </div>
      {p.dropAfter && <div aria-hidden className="pointer-events-none -mt-px h-[2px] rounded-full bg-accent" />}

      {tagEditing && <TagEditor tags={p.tags} allTags={p.allTags} onTags={p.onTags} onClose={() => setTagEditing(false)} />}
      {menuOpen && <RowMenu items={items} up={p.up} ariaLabel={`Session actions for ${p.title}`} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

export default function LiveSessionsList({ sessions, sessionTitles = {}, subagentStatuses = {}, activeId, onSelect, onRefresh, pendingUiCounts = {} }: LiveSessionsListProps) {
  const [groups, setGroups] = useState<LiveSessionGroup[]>([])
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [starting, setStarting] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [startCwd, setStartCwd] = useState('')
  const [startCwdMenuOpen, setStartCwdMenuOpen] = useState(false)
  const [startCwdCursor, setStartCwdCursor] = useState(0)
  const startCwdRef = useRef<HTMLInputElement>(null)
  const [startModel, setStartModel] = useState('')
  const [startModels, setStartModels] = useState<(ModelLike & { contextWindow?: number })[]>([])
  const [startModelsLoading, setStartModelsLoading] = useState(false)
  const [startModelsError, setStartModelsError] = useState<string>()
  const [startTitle, setStartTitle] = useState('')
  const [startThinking, setStartThinking] = useState('max')
  const [startError, setStartError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  /** A bulk `/reload` of every main session is in flight. */
  const [reloadingAll, setReloadingAll] = useState(false)
  const [reloadNotice, setReloadNotice] = useState<{ text: string; danger: boolean } | null>(null)
  /** processInstanceId of the session whose "从此分叉" launch is in flight. */
  const [forkingId, setForkingId] = useState<string | null>(null)
  const [forkError, setForkError] = useState<string>()
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [armedGroup, setArmedGroup] = useState<string | null>(null)
  const { meta, allTags, tagCounts, patch, refresh: refreshMeta, error: metaError } = useLiveSessionMeta()
  const { order, save: saveOrder, reset: resetOrder, refresh: refreshOrder, error: orderError } = useLiveSessionOrder()

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await liveSessionApi.listGroups())
      setError(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => { void refreshGroups() }, [refreshGroups])

  /**
   * Bulk counterpart of the per-session 重载 button.
   *
   * After dashboard extensions / skills / prompts / themes change, every running
   * Pi has to re-read them, and reconnecting each session by hand is tedious.
   * Subagent child processes are skipped by the backend, so only main sessions
   * are counted here.
   */
  const reloadAllSessions = () => {
    if (reloadingAll) return
    const targets = sessions.filter(session => session.role !== 'subagent')
    if (targets.length === 0) {
      setReloadNotice({ text: '没有可重载的主会话（子 Agent 进程会被跳过）', danger: false })
      return
    }
    if (!window.confirm(`重载全部 ${targets.length} 个会话？每个 Pi 进程会重新加载扩展 / 技能 / 提示词 / 主题，Web 端会短暂重连。`)) return
    setReloadingAll(true)
    setReloadNotice(null)
    void liveSessionApi.reloadAll()
      .then(result => setReloadNotice({ text: reloadAllSummary(result), danger: result.failed.length > 0 }))
      .catch(reason => setReloadNotice({ text: `重载失败：${reason instanceof Error ? reason.message : String(reason)}`, danger: true }))
      .finally(() => setReloadingAll(false))
  }

  // The notice is transient: rows recover on their own once each Pi reconnects.
  useEffect(() => {
    if (!reloadNotice) return
    const timer = window.setTimeout(() => setReloadNotice(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [reloadNotice])

  /**
   * Follow an in-process session switch (`/clear`, `/ls-fork`).
   *
   * Order, groups and tags are keyed by pi `sessionId`, which changes while the
   * row's `processInstanceId` does not. The server re-keys its stores when it sees
   * that change; the copies in this component are stale until re-read, and until
   * then the row would fall back to the block tail with its tags and pin gone.
   */
  const knownSessionIds = useRef(new Map<string, string>())
  useEffect(() => {
    let switched = false
    const next = new Map<string, string>()
    for (const session of sessions) {
      const previous = knownSessionIds.current.get(session.processInstanceId)
      if (previous && previous !== session.sessionId) switched = true
      next.set(session.processInstanceId, session.sessionId)
    }
    knownSessionIds.current = next
    if (!switched) return
    void refreshMeta()
    void refreshOrder()
    void refreshGroups()
  }, [sessions, refreshMeta, refreshOrder, refreshGroups])

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
      setStartError(formatStartError(reason instanceof Error ? reason.message : String(reason)))
      setStarting(false)
    }
  }

  const groupOf = useCallback((session: LiveSessionSummary): LiveSessionGroup | undefined => groupOfSession(session, groups), [groups])

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

  const sections = useMemo<SessionSection[]>(() => buildSessionSections(visible, meta, groups, order), [visible, groups, meta, order])

  /** A block's rows without the dragged session — the coordinate system every
   *  drop index (and the insertion line) is expressed in. */
  const anchorsFor = useCallback((sectionId: string, excludeSessionId?: string): string[] => {
    const section = sections.find(candidate => candidate.id === sectionId)
    if (!section) return []
    return section.sessions.map(session => session.sessionId).filter(id => id !== excludeSessionId)
  }, [sections])

  /** Every row currently on screen, in display order — the base a move edits. */
  const displayedIds = useMemo(() => sections.flatMap(section => section.sessions.map(session => session.sessionId)), [sections])

  /**
   * 「从此分叉」— start a NEW Pi forked from this session's file (pi `--fork`).
   *
   * The source session keeps running (unlike the graph's `/ls-fork`, which swaps
   * the current process to the fork in place), so the fork shows up next to it:
   * it inherits the source's task group (and pin, so it stays in the same block)
   * and is inserted right after the parent in the manual order.
   */
  const forkSession = useCallback(async (session: LiveSessionSummary) => {
    const sessionFile = session.sessionFile
    if (!sessionFile) {
      setForkError('该 session 还没有会话文件，无法分叉')
      return
    }
    setForkingId(session.processInstanceId)
    setForkError(undefined)
    try {
      const result = await liveSessionApi.start({
        cwd: session.canonicalCwd || session.cwd,
        ...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
        ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
        title: `${sessionTitle(session, sessionTitles)} · 分叉`,
        forkFrom: sessionFile,
      })
      if (!result.processInstanceId || !result.sessionId) throw new Error('新 Pi 已启动，但没有拿到会话标识')
      const forkedProcessInstanceId = result.processInstanceId
      const forkedSessionId = result.sessionId
      // Inherit the task group first: membership is keyed by sessionId, which the
      // start response just gave us.
      const parentGroup = groupOf(session)
      if (parentGroup) setGroups(await liveSessionApi.addGroupMember(parentGroup.id, forkedProcessInstanceId))
      if (meta[session.sessionId]?.pinned) await patch(forkedProcessInstanceId, forkedSessionId, { pinned: true })
      // Sit right after the parent: both end up in the same block and the order
      // list puts the new sessionId directly behind its source.
      const base = materializeOrder(order, displayedIds)
      const parentIndex = base.indexOf(session.sessionId)
      const insertAt = parentIndex >= 0 ? parentIndex + 1 : base.length
      await saveOrder([...base.slice(0, insertAt), forkedSessionId, ...base.slice(insertAt)])
      window.setTimeout(() => { void onRefresh?.() }, 1_000)
    } catch (reason) {
      setForkError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setForkingId(null)
    }
  }, [displayedIds, groupOf, meta, onRefresh, order, patch, saveOrder, sessionTitles])

  // ─────────────────────── drag to reorder ──────────────────────
  //
  // A press only becomes a drag after DRAG_THRESHOLD pixels, so clicking a row
  // to open it still works. Touch deliberately does not start a drag (moving a
  // finger must keep scrolling the list); the `⋯` menu carries ↑/↓/⤒ there.
  const [drag, setDrag] = useState<{ sessionId: string; processInstanceId: string } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [dropTarget, setDropTarget] = useState<DropTarget | undefined>(undefined)
  const dragOrigin = useRef<{ x: number; y: number } | null>(null)
  const dragActiveRef = useRef(false)
  const dropTargetRef = useRef<DropTarget | undefined>(undefined)
  /** Swallows the single click that follows a drag, and is re-armed on the next press. */
  const suppressSelect = useRef(false)

  const beginDrag = (session: LiveSessionSummary, event: React.PointerEvent<HTMLDivElement>) => {
    suppressSelect.current = false
    if (event.button !== 0 || event.pointerType === 'touch') return
    if ((event.target as HTMLElement).closest('button, input, textarea, a, [role="menu"], [role="dialog"]')) return
    dragOrigin.current = { x: event.clientX, y: event.clientY }
    setDrag({ sessionId: session.sessionId, processInstanceId: session.processInstanceId })
  }

  /**
   * Apply one drop: the moved row's position, plus the block it landed in.
   *
   * Dropping into a task group re-assigns membership (the server drops the
   * session from its previous group); dropping into or out of 置顶 toggles the
   * pin. The order list is written whole, so a cross-block move is one PUT plus
   * at most one membership call.
   */
  const applyDrop = useCallback(async (target: DropTarget | undefined, moved: { sessionId: string; processInstanceId: string }) => {
    if (!target) return
    const section = sections.find(candidate => candidate.id === target.sectionId)
    const session = sessions.find(candidate => candidate.sessionId === moved.sessionId)
    if (!section || !session) return
    const anchors = section.sessions.map(item => item.sessionId).filter(id => id !== moved.sessionId)
    const base = materializeOrder(order, displayedIds)
    const tasks: Promise<unknown>[] = [saveOrder(moveInOrder(base, moved.sessionId, anchors, target.index))]
    const pinnedNow = !!meta[moved.sessionId]?.pinned
    const currentGroup = groupOf(session)
    if (section.pinnedSection) {
      if (!pinnedNow) tasks.push(patch(session.processInstanceId, session.sessionId, { pinned: true }))
    } else {
      if (pinnedNow) tasks.push(patch(session.processInstanceId, session.sessionId, { pinned: false }))
      if (section.group && currentGroup?.id !== section.group.id) {
        const groupId = section.group.id
        tasks.push(mutateGroups(() => liveSessionApi.addGroupMember(groupId, session.processInstanceId)))
      } else if (!section.group && currentGroup) {
        const groupId = currentGroup.id
        tasks.push(mutateGroups(() => liveSessionApi.removeGroupMember(groupId, session.sessionId)))
      }
    }
    await Promise.all(tasks)
  }, [sections, sessions, order, displayedIds, meta, groupOf, patch, saveOrder, mutateGroups])

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent) => {
      const origin = dragOrigin.current
      if (!dragActiveRef.current && origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= DRAG_THRESHOLD) {
        dragActiveRef.current = true
        setDragActive(true)
      }
      if (!dragActiveRef.current) return
      const element = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : null
      const next = resolveDropTarget(element, node => node.getBoundingClientRect(), event.clientY, id => anchorsFor(id, drag.sessionId))
      const previous = dropTargetRef.current
      if (previous?.sectionId === next?.sectionId && previous?.index === next?.index) return
      dropTargetRef.current = next
      setDropTarget(next)
    }
    const finish = (cancelled: boolean) => {
      const dropped = dropTargetRef.current
      const moved = drag
      const wasDragging = dragActiveRef.current
      dragActiveRef.current = false
      dragOrigin.current = null
      dropTargetRef.current = undefined
      setDragActive(false)
      setDropTarget(undefined)
      setDrag(null)
      if (!wasDragging || cancelled) return
      suppressSelect.current = true
      void applyDrop(dropped, moved)
    }
    const onUp = () => finish(false)
    const onCancel = () => finish(true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [drag, anchorsFor, applyDrop])

  /** Menu fallback for touch/keyboard: move one slot inside the row's own block. */
  const moveRow = (session: LiveSessionSummary, place: 'up' | 'down' | 'top') => {
    const section = sections.find(candidate => candidate.sessions.some(item => item.sessionId === session.sessionId))
    if (!section) return
    const list = section.sessions.map(item => item.sessionId)
    const current = list.indexOf(session.sessionId)
    if (current < 0) return
    const anchors = list.filter(id => id !== session.sessionId)
    const index = place === 'top' ? 0 : place === 'up' ? current - 1 : current + 1
    if (index < 0 || index > anchors.length) return
    void saveOrder(moveInOrder(materializeOrder(order, displayedIds), session.sessionId, anchors, index))
  }

  const selectRow = (session: LiveSessionSummary) => {
    if (suppressSelect.current) { suppressSelect.current = false; return }
    onSelect(session.processInstanceId)
  }

  /** Section subtitle as colored counts — a dot carries the state, so the line
   *  reads as a status summary instead of a wall of grey text. */
  const summaryNodes = (items: LiveSessionSummary[]): React.ReactNode => {
    const parts = [
      { key: 'waiting', label: '等待', dot: 'bg-muted-strong opacity-50', count: items.filter(session => session.status === 'idle').length },
      { key: 'working', label: '工作', dot: 'bg-accent', count: items.filter(session => session.status === 'running').length },
      { key: 'reconnecting', label: '重连', dot: 'bg-warn', count: items.filter(session => session.status === 'reconnecting').length },
    ].filter(part => part.count > 0)
    if (parts.length === 0) return <span>暂无在线 session</span>
    return <>{parts.map(part => (
      <span key={part.key} className="inline-flex items-center gap-1">
        <span className={`h-1.5 w-1.5 rounded-full ${part.dot}`} aria-hidden="true" />
        {part.count} {part.label}
      </span>
    ))}</>
  }

  const rowHandlers = (session: LiveSessionSummary) => ({
    onPin: (pinned: boolean) => void patch(session.processInstanceId, session.sessionId, { pinned }),
    onTags: (tags: string[]) => void patch(session.processInstanceId, session.sessionId, { tags }),
    onRename: (name: string) => { void liveSessionApi.rename(session.processInstanceId, name).then(() => onRefresh?.()) },
    onFork: () => { void forkSession(session) },
    onJoinGroup: (groupId: string) => void mutateGroups(() => liveSessionApi.addGroupMember(groupId, session.processInstanceId)),
    onLeaveGroup: (groupId: string) => void mutateGroups(() => liveSessionApi.removeGroupMember(groupId, session.sessionId)),
    onCopySessionId: () => { void navigator.clipboard?.writeText(session.sessionId).catch(() => {}) },
    onCopyTerminalCommand: () => {
      const tmux = meta[session.sessionId]?.tmux
      if (tmux) void navigator.clipboard?.writeText(`tmux attach -t ${tmux}`).catch(() => {})
    },
    // tmux-first live sessions are closed by killing their tmux session; the Pi
    // inside it exits with the pane and the sidebar row disappears on its own.
    onCloseSession: () => {
      const tmux = meta[session.sessionId]?.tmux
      if (!tmux) return
      void liveSessionApi.closeTmuxSession(tmux).then(() => onRefresh?.()).catch(reason => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    },
  })

  const renderRows = (section: SessionSection) => {
    const items = section.sessions
    const anchors = items.map(session => session.sessionId).filter(id => id !== drag?.sessionId)
    const target = dropTarget?.sectionId === section.id ? dropTarget.index : undefined
    return items.map((session, index) => {
      const group = groupOf(session)
      const subagent = isSubagent(session)
      return (
        <SessionRow
          key={session.processInstanceId}
          session={session}
          title={sessionTitle(session, sessionTitles)}
          depth={0}
          blockId={section.id}
          dragging={dragActive && drag?.sessionId === session.sessionId}
          dropBefore={target !== undefined && anchors.indexOf(session.sessionId) === target}
          dropAfter={target !== undefined && target === anchors.length && index === items.length - 1}
          onDragStart={event => beginDrag(session, event)}
          onMove={place => moveRow(session, place)}
          moveIndex={index}
          moveCount={items.length}
          active={activeId === session.processInstanceId}
          groupName={group?.name}
          childCount={childrenByParent.get(session.sessionId) || 0}
          subagent={subagent}
        taskStatus={subagent && session.subagentWorkId ? subagentStatuses[session.subagentWorkId] : undefined}
          tags={meta[session.sessionId]?.tags || []}
          pinned={!!meta[session.sessionId]?.pinned}
          pendingUiCount={pendingUiCounts[session.processInstanceId]}
          tagFilter={tagFilter}
          allTags={allTags}
          groups={groups}
          up={index >= items.length - 2}
          busy={busy}
          onSelect={() => selectRow(session)}
          tmuxSession={meta[session.sessionId]?.tmux}
          onToggleTagFilter={tag => setTagFilter(current => current === tag ? null : tag)}
          {...rowHandlers(session)}
        />
      )
    })
  }

  return (
    <aside className={`pidash-sidebar flex w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-accent md:w-[320px] ${dragActive ? 'select-none' : ''}`}>
      <div className="sticky top-0 z-10 border-b border-border bg-bg-accent px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-meta font-semibold uppercase tracking-[.05em] text-muted">
            Live Pi Sessions
            <span className="ml-1.5 font-mono text-2xs normal-case tracking-normal text-muted-strong">
              {visible.length === sessions.length ? sessions.length : `${visible.length}/${sessions.length}`}
            </span>
          </div>
          <button type="button" disabled={busy || starting} onClick={() => setStartOpen(value => !value)} className="flex shrink-0 items-center gap-0.5 rounded-full bg-bg px-2 py-0.5 text-2xs text-muted transition hover:bg-bg-hover hover:text-text disabled:opacity-50" title="启动一个新的 Live Pi"><MaterialIcon name="add" className="h-3.5 w-3.5" />启动</button>
          <button type="button" disabled={busy || starting} onClick={() => setCreating(value => !value)} className="flex shrink-0 items-center gap-0.5 rounded-full bg-bg px-2 py-0.5 text-2xs text-muted transition hover:bg-bg-hover hover:text-text disabled:opacity-50" title="新建任务分组"><MaterialIcon name="add" className="h-3.5 w-3.5" />任务</button>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <SearchInput className="min-w-0 flex-1" placeholder="搜索 session / 目录 / 标签…" value={filter} onChange={e => setFilter(e.target.value)} />
          <button
            type="button"
            disabled={reloadingAll}
            onClick={reloadAllSessions}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-2xs text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
            title="重载所有会话：让每个 Pi 进程重新加载扩展 / 技能 / 提示词 / 主题（子 Agent 进程跳过）"
          ><MaterialIcon name="sync" spin={reloadingAll} className="h-3.5 w-3.5" />重载全部</button>
        </div>

        {reloadNotice && <div role="status" aria-label="重载结果" className={`mt-1.5 text-2xs ${reloadNotice.danger ? 'text-danger' : 'text-muted-strong'}`}>{reloadNotice.text}</div>}

        {tagCounts.length > 0 && (
          <div className="mt-1.5 flex items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" onClick={() => setTagFilter(null)}
              className={`shrink-0 rounded-full border px-2 py-px text-2xs font-semibold leading-[16px] ${!tagFilter ? 'border-border-strong bg-bg-hover text-text-strong' : 'border-transparent text-muted hover:text-text'}`}>全部</button>
            {tagCounts.slice(0, 12).map(({ tag, count }) => (
              <TagChip key={tag} tag={tag} active={tagFilter === tag} onClick={t => setTagFilter(current => current === t ? null : t)} title={`#${tag} · ${count} 个 session`} />
            ))}
          </div>
        )}

        {(startOpen || creating) && <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg p-2">
          {startOpen && <form onSubmit={event => { void startLivePi(event) }} className="space-y-1.5">
            <div className="text-2xs font-semibold text-accent">启动 Live Pi</div>
            <input
              ref={startCwdRef}
              autoFocus
              value={startCwd}
              onChange={event => { setStartCwd(event.target.value); setStartCwdCursor(event.target.selectionStart ?? 0) }}
              onKeyDown={event => {
                // Tab drives directory completion, same affordance as the chat
                // composer. Typing a path that does not exist is the single
                // most common start failure, so make the valid choices visible.
                if (event.key === 'Tab' && !event.shiftKey) {
                  event.preventDefault()
                  setStartCwdCursor(startCwdRef.current?.selectionStart ?? 0)
                  setStartCwdMenuOpen(true)
                } else if (event.key === 'Escape') setStartCwdMenuOpen(false)
              }}
              placeholder="工作目录，例如 /mnt/workspace/lilong/repos/...（Tab 补全）"
              className="w-full rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none focus:border-accent"
            />
            <div className="text-2xs leading-[15px] text-muted-strong">
              必须是<b>已存在</b>的绝对目录（或 <span className="font-mono">~/…</span>），且在白名单根目录内；按 Tab 可补全目录。
            </div>
            {startCwdMenuOpen && <PathCompleteMenu
              input={startCwd}
              cursorPos={startCwdCursor}
              anchorRef={startCwdRef}
              onComplete={(before, completed, after) => {
                setStartCwd(before + completed + after)
                setStartCwdMenuOpen(true)
                setTimeout(() => {
                  const input = startCwdRef.current
                  if (!input) return
                  const pos = before.length + completed.length
                  input.selectionStart = input.selectionEnd = pos
                  setStartCwdCursor(pos)
                }, 0)
              }}
              onClose={() => setStartCwdMenuOpen(false)}
            />}
            <select value={startModel} onChange={event => setStartModel(event.target.value)} disabled={startModelsLoading} className="w-full rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none disabled:opacity-60" title="选择启动模型">
              <option value="">{startModelsLoading ? '读取模型列表…' : '默认模型'}</option>
              {startModels.map(model => <option key={modelFullId(model)} value={modelFullId(model)}>{modelLabel(model)} · {modelFullId(model)}</option>)}
            </select>
            {startModelsError && <div className="text-2xs text-warn">模型列表读取失败，将使用默认模型</div>}
            <div className="flex gap-1.5">
              <select value={startThinking} onChange={event => setStartThinking(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-1 text-2xs text-text outline-none">
                {THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
              </select>
              <input value={startTitle} onChange={event => setStartTitle(event.target.value)} placeholder="标题（可选）" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none focus:border-accent" />
            </div>
            <div className="flex gap-1">
              <button type="submit" disabled={starting || !startCwd.trim()} className="flex-1 rounded bg-accent px-2 py-1 text-2xs text-accent-fg disabled:opacity-50">{starting ? '启动中…' : '启动'}</button>
              <button type="button" disabled={starting} onClick={() => setStartOpen(false)} className="rounded border border-border px-2 py-1 text-2xs text-muted">取消</button>
            </div>
            {starting && <div className="text-2xs text-muted">冷启动通常 5–20 秒；机器繁忙时可能超过 1 分钟，请勿重复点击。</div>}
            {startError && <div className="whitespace-pre-wrap break-words text-2xs text-danger">启动失败：{startError}</div>}
          </form>}
          {creating && <form onSubmit={event => { void createGroup(event) }} className="flex gap-1 border-t border-border pt-2">
            <input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} placeholder="任务分组名称" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none focus:border-accent" />
            <button type="submit" disabled={busy || !newGroupName.trim()} className="rounded border border-border px-2 py-1 text-2xs text-muted disabled:opacity-50">创建</button>
          </form>}
        </div>}

        {error && <div className="mt-2 text-2xs text-danger">分组同步失败：{error}</div>}
        {forkingId && <div className="mt-2 text-2xs text-accent">正在分叉…（等待新 Pi 注册，最多 2 分钟）</div>}
        {forkError && <div className="mt-2 whitespace-pre-wrap break-words text-2xs text-danger">分叉失败：{formatStartError(forkError)}</div>}
        {tagFilter && (
          <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-strong">
            仅显示 <TagChip tag={tagFilter} active /> 的 session
            <button type="button" className="underline hover:text-text" onClick={() => setTagFilter(null)}>清除</button>
          </div>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="p-5 text-sm text-muted">暂无已连接的 Pi session。已运行的 Pi 需要加载集成 Extension。</div>
      ) : sections.length === 0 ? (
        <div className="p-5 text-meta text-muted-strong">没有匹配的 session{filter || tagFilter ? '（清除筛选试试）' : ''}</div>
      ) : sections.map(section => (
        <section key={section.id} data-live-block={section.id} className="border-b border-border">
          <div className="group/section flex items-center gap-1 px-2.5 pb-1 pt-2.5">
            <span className={`flex shrink-0 items-center ${section.pinnedSection ? 'text-accent' : 'text-muted-strong'}`} aria-hidden="true"><MaterialIcon name="expand_more" className="h-4 w-4" /></span>
            {section.pinnedSection && <span className="flex shrink-0 items-center text-accent" title="置顶分组"><MaterialIcon name="push_pin" className="h-3.5 w-3.5" /></span>}
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
                className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-meta text-text-strong outline-none"
              />
            ) : (
              <strong className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-[.06em] text-text-strong" title={section.name}>{section.name}</strong>
            )}
            <span className="shrink-0 rounded-full bg-bg-hover px-1.5 font-mono text-2xs leading-[14px] text-muted-strong">{section.sessions.length}</span>
            {section.group && <>
              <button type="button" disabled={busy} aria-label="重命名任务分组按钮" onClick={() => { setRenamingGroup(section.id); setGroupDraft(section.name) }} className="flex items-center rounded px-1 text-muted opacity-60 transition-opacity hover:bg-bg-hover hover:text-accent focus-visible:opacity-100 md:opacity-0 md:group-hover/section:opacity-100" title="重命名任务"><MaterialIcon name="edit" className="h-3.5 w-3.5" /></button>
              <button
                type="button"
                disabled={busy}
                aria-label="删除任务分组"
                onClick={() => {
                  if (armedGroup === section.id) { setArmedGroup(null); void mutateGroups(() => liveSessionApi.deleteGroup(section.id!)) }
                  else setArmedGroup(section.id)
                }}
                className={`flex shrink-0 items-center rounded px-1 text-2xs transition-opacity ${armedGroup === section.id ? 'bg-danger-subtle font-semibold text-danger' : 'text-muted opacity-60 hover:bg-danger-subtle hover:text-danger focus-visible:opacity-100 md:opacity-0 md:group-hover/section:opacity-100'}`}
                title={armedGroup === section.id ? '再点一次确认删除（session 不会被删除）' : '删除任务分组'}
              >{armedGroup === section.id ? '确认删除' : <MaterialIcon name="close" className="h-3.5 w-3.5" />}</button>
            </>}
          </div>
          <div className="flex items-center gap-2.5 px-2.5 pb-1 text-2xs text-muted-strong">{section.group || section.pinnedSection ? summaryNodes(section.sessions) : `${section.sessions.length} 个 session`}</div>
          <div className="pb-1.5">{renderRows(section)}</div>
        </section>
      ))}

      <div className="mt-auto flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-2xs text-muted-strong">
        <span className="flex items-center gap-1" title="行位置来自手动拖动，不会因活跃时间或上线状态自行变化"><MaterialIcon name="swap_vert" className="h-3.5 w-3.5" />排序：手动</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void resetOrder()}
          className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-muted transition hover:bg-bg-hover hover:text-text disabled:opacity-50"
          title="清空手动顺序，行位置回到按启动时间排列"
        ><MaterialIcon name="restore" className="h-3.5 w-3.5" /><span>恢复自动排序</span></button>
        {orderError !== undefined && <span className="shrink-0 text-danger" title={orderError}>顺序同步失败</span>}
      </div>

      <div className="px-3 py-2 text-2xs text-muted-strong">
        拖动行可调顺序，拖到别的分组即改归属；触屏用 ⋯ 里的箭头菜单
        {metaError !== undefined && <button type="button" className="ml-1 text-danger underline" onClick={() => void refreshMeta()}>· 标签同步失败，点击重试</button>}
      </div>
    </aside>
  )
}
