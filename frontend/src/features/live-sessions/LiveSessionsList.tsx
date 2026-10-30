import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LiveSessionGroup, LiveSessionMeta, LiveSessionReloadResult, LiveSessionSummary, RepoCandidate } from '@shared/live-sessions'
import SessionAppearanceDialog, { type SessionAppearance } from './SessionAppearanceDialog'
import { displayWorktreePath } from '../../utils/displayPath'
import { api } from '../../api/client'
import type { ModelLike } from '../../utils/modelUtils'
import { modelFullId, modelLabel } from '../../utils/modelUtils'
import PathCompleteMenu from '../../components/PathCompleteMenu'
import { TagChip, TagEditor, RowMenu, type RowMenuAction, type RowMenuItem } from '../../components/sessionMetaUi'
import LineIcon from '../../components/LineIcon'
import { tagColorClass } from '../../pages/chat/sessionMeta'
import MaterialIcon, { type MaterialIconName } from '../../components/MaterialIcon'
import MuyuIcon from '../../components/MuyuIcon'
import { relTime, projectName } from '../../pages/chat/sessionMeta'
import { liveSessionApi } from './api'
import type { SubagentTaskStatus } from './sessionTitle'
import { moveInOrder, materializeOrder, resolveDropTarget, buildSessionSections, sectionOrderIds, isHoldGroup, groupOfSession, isSubagent, type DropTarget, type SessionSection } from './sessionOrder'
import { START_PATH_HISTORY_KEEP, isPathLikeQuery, matchStartPaths, mergeStartPathHistory } from './startPathHistory'
import { useLiveSessionMeta } from './useLiveSessionMeta'
import { useLiveSessionOrder } from './useLiveSessionOrder'
import { useArmedConfirm } from '../../hooks/useArmedConfirm'

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

/** 分组用淡色底区分，按顺序轮换；样式见 index.css 的 .session-tint-*（统一深浅）。 */
const SECTION_TINTS = ['session-tint-0', 'session-tint-1', 'session-tint-2', 'session-tint-3', 'session-tint-4']

const MAX_TAG_CHIPS = 2

/**
 * Launcher failures are accurate but cryptic (`live_pi_registration_timeout:
 * ... was killed after 120000ms without registering`). Translate the ones users
 * actually hit, and keep any Pi pane output the backend attached — that text is
 * the only clue about why the start hung.
 */
function formatStartError(message: string): string {
  const paneTail = message.split('\n').slice(1).join('\n').trim()
  if (message.includes('live_pi_blocked_on_prompt')) {
    const hint = '这次启动卡在 Pi 的「是否信任该工程目录」提问上：启动用的后台窗口没人能按键，Pi 就一直没注册，所以看起来像超时。解决办法任选一个：在终端里对该目录跑一次 pi 并选 Trust（会记进 ~/.pi/agent/trust.json，或直接手写该目录或其父目录）；或者给这台机器设 liveSessions.launch.approve=true 让它启动时自动信任。'
    return `${hint}${paneTail ? `\n${paneTail}` : ''}`
  }
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
  groupId?: string
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
  appearance?: Pick<LiveSessionMeta, 'color' | 'emoji'>
  onAppearance: (appearance: SessionAppearance) => Promise<void>
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
  onExitSession: () => Promise<void>
  restartDisabledReason?: string
  shutdownDisabledReason?: string
  onRestartSession: () => Promise<void>
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
  reorderMode?: boolean
}

function SessionRow(p: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [tagEditing, setTagEditing] = useState(false)
  const [appearanceEditing, setAppearanceEditing] = useState(false)
  const [renameValue, setRenameValue] = useState(p.title)
  const [exitArmed, setExitArmed] = useState(false)
  const [exitPending, setExitPending] = useState(false)
  const [restartArmed, setRestartArmed] = useState(false)
  const [restartPending, setRestartPending] = useState(false)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    if (!exitArmed) return
    const timer = window.setTimeout(() => setExitArmed(false), 5_000)
    return () => window.clearTimeout(timer)
  }, [exitArmed])

  useEffect(() => {
    if (!exitPending) return
    const timer = window.setTimeout(() => setExitPending(false), 8_000)
    return () => window.clearTimeout(timer)
  }, [exitPending])

  useEffect(() => {
    if (!restartArmed) return
    const timer = window.setTimeout(() => setRestartArmed(false), 5_000)
    return () => window.clearTimeout(timer)
  }, [restartArmed])

  const requestRestart = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (restartPending || p.restartDisabledReason) return
    if (!restartArmed) {
      setRestartArmed(true)
      return
    }
    setRestartArmed(false)
    setRestartPending(true)
    void p.onRestartSession().finally(() => setRestartPending(false))
  }

  const requestReload = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (reloading || p.session.status === 'reconnecting') return
    setReloading(true)
    void liveSessionApi.command(p.session.processInstanceId, { type: 'reload' })
      .finally(() => setTimeout(() => setReloading(false), 800))
  }

  const requestExit = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (exitPending || p.shutdownDisabledReason) return
    if (!exitArmed) {
      setExitArmed(true)
      return
    }
    setExitArmed(false)
    setExitPending(true)
    void p.onExitSession().catch(() => setExitPending(false))
  }

  const tone = statusTone(p.session)
  // dot colour comes only from data the row already has: a pending question
  // (clarify), a running turn (accent), a completed goal (ok); otherwise hollow.
  const goalDone = !!p.session.goal && (p.session.goal.total > 0 ? p.session.goal.done === p.session.goal.total && !p.session.goal.stale : p.session.goal.status === 'complete')
  const rowBusy = menuOpen || restartArmed || restartPending || exitArmed || exitPending
  const dotKind = (p.pendingUiCount ?? 0) > 0 ? 'waiting' : tone === 'running' ? 'running' : goalDone ? 'done' : 'idle'
  const chips = p.tags.slice(0, MAX_TAG_CHIPS)
  const extra = p.tags.length - chips.length
  const cwd = p.session.canonicalCwd || p.session.cwd
  const branch = p.session.git?.branch

  const groupItems: RowMenuAction[] = p.groups.map(g => (g.id === p.groupId
    ? { label: `⇤ 移出「${g.name}」`, onClick: () => p.onLeaveGroup(g.id) }
    : { label: `→ 加入「${g.name}」`, onClick: () => p.onJoinGroup(g.id) }))
  const orderActions: RowMenuAction[] = [
    { label: p.pinned ? '📌 取消置顶' : '📌 置顶', shortLabel: p.pinned ? '📌✓' : '📌', onClick: () => p.onPin(!p.pinned) },
    ...(p.moveIndex > 0 ? [
      { label: '↑ 上移', shortLabel: '↑', onClick: () => p.onMove('up') },
      { label: '⤒ 移到本组顶部', shortLabel: '⤒', onClick: () => p.onMove('top') },
    ] : []),
    ...(p.moveIndex >= 0 && p.moveIndex < p.moveCount - 1
      ? [{ label: '↓ 下移', shortLabel: '↓', onClick: () => p.onMove('down') }]
      : []),
  ]

  const items: RowMenuItem[] = [
    { actions: [
      { label: '✎ 重命名', onClick: () => { setRenameValue(p.title); setRenaming(true) } },
      { label: '🏷 标签', onClick: () => setTagEditing(true) },
      { label: '🎨 会话装扮', onClick: () => setAppearanceEditing(true) },
    ] },
    ...(p.subagent ? [] : [{ label: '⑂ 从此分叉', hint: '独立 Pi 会话', inlineHint: true, onClick: p.onFork } as RowMenuItem]),
    { separator: true },
    { actions: orderActions },
    ...(p.tmuxSession ? [
      { separator: true } as RowMenuItem,
      // The tmux session IS the terminal handle. Its name lives here, not on the
      // row, so the row stays about the project and the menu answers “which tmux?”.
      { info: {
          label: '终端 · tmux 会话',
          value: p.tmuxSession,
          actionLabel: '⧉ 复制 attach 命令',
          onAction: p.onCopyTerminalCommand,
          title: `tmux attach -t ${p.tmuxSession}（点击复制）`,
      } } as RowMenuItem,
      { actions: [
        { label: '⧉ 复制终端命令', shortLabel: '⧉ 命令', hint: `tmux attach -t ${p.tmuxSession}`, onClick: p.onCopyTerminalCommand },
        { label: '⏻ 关闭 session（kill tmux）', shortLabel: '⏻ 关闭', hint: `${p.tmuxSession} · Pi 进程会一起结束`, confirmLabel: '确认关闭', danger: true, onClick: p.onCloseSession },
      ] } as RowMenuItem,
    ] : []),
    ...(groupItems.length ? [
      { separator: true } as RowMenuItem,
      { label: '移动到分组', submenu: groupItems } as RowMenuItem,
    ] : []),
    { separator: true },
    { label: '⧉ 复制 Session ID', shortLabel: '⧉ 复制 ID', hint: `${shortSessionId(p.session.sessionId)} · pid ${p.session.pid}`, inlineHint: true, onClick: p.onCopySessionId },
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
        data-session-color={p.appearance?.color || undefined}
        title={`${p.title}\n${cwd}${branch ? ` · ${branch}` : ''}`}
        onMouseDown={e => e.preventDefault()}
        onPointerDown={p.onDragStart}
        onClick={p.onSelect}
        onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect() } }}
        className={`live-session-row relative group flex cursor-pointer gap-2 rounded-md px-2 py-1.5 transition-colors ${p.depth ? 'ml-4' : ''} ${p.dragging ? 'opacity-40' : ''} ${p.active ? 'bg-card shadow-sm' : 'hover:bg-bg-hover'}`}
      >
        {p.appearance?.color && <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-0 w-[3px] rounded-r" style={{ backgroundColor: p.appearance.color }} />}
        {p.active && <span aria-hidden="true" className="pointer-events-none absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-accent" />}
        {/* status gutter — the running glyph spans both text lines so the swing
            has room; every other status is a quiet dot or a spinner */}
        <span
          className={`flex shrink-0 justify-center ${dotKind === 'running' ? '-ml-1 w-[30px] items-start' : 'h-[18px] w-3 items-center'}`}
          role="status"
          aria-label={`Session 状态：${statusLabel(p.session.status)}`}
          data-session-status={p.session.status}
          data-session-dot={dotKind}
          title={statusLabel(p.session.status)}
        >{p.session.status === 'reconnecting'
          ? <MaterialIcon name="sync" spin className="h-3 w-3 text-warn" />
          // 运行中保留原有的敲木鱼动画（产品既有的标志性提示），其他状态用小圆点。
          : dotKind === 'running' ? <MuyuIcon className="working-muyu-row" />
          : dotKind === 'waiting' ? <span className="h-2 w-2 rounded-full bg-clarify" />
          : dotKind === 'done' ? <span className="h-2 w-2 rounded-full bg-ok" />
          : <span className="h-2 w-2 rounded-full border border-muted-strong opacity-60" aria-hidden="true" />}</span>
        <div className="min-w-0 flex-1">
          {/* line 1 — title */}
          <div className="flex h-[18px] items-center gap-1.5">
            {p.depth > 0 && <span className="shrink-0 text-2xs leading-none text-accent">↳</span>}
            {!renaming && (
              <button
                type="button"
                aria-label={`设置 ${p.title} 的装扮和名称`}
                title="点击设置会话表情和名称"
                onClick={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  setAppearanceEditing(true)
                }}
                className="flex shrink-0 items-center rounded hover:opacity-80"
              >
                {p.appearance?.emoji ? (
                  <span data-session-emoji className="max-w-16 truncate text-2xs leading-none" title={p.appearance.emoji}>{p.appearance.emoji}</span>
                ) : (
                  <span className="text-2xs opacity-40 hover:opacity-100" title="设置表情和颜色">🏷️</span>
                )}
              </button>
            )}
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
              <span className={`min-w-0 flex-1 truncate text-meta font-medium leading-[16px] ${tone === 'idle' && !p.active ? 'text-text' : 'text-text-strong'}`}>{p.title}</span>
            )}
            {p.session.claim.state === 'claimed' && <span className="flex shrink-0 items-center text-muted-strong" title="已被其他浏览器接管"><MaterialIcon name="lock" className="h-3.5 w-3.5" /></span>}
            {/* "活动" is the session's LAST activity, not how long it has run: an idle
                Pi sends nothing, so this is the honest "silent since" clock. The label
                is spelled out because the bare number read as an unexplained “几秒”. */}
            <span className={`flex shrink-0 items-center gap-0.5 font-mono text-2xs leading-none text-muted ${rowBusy ? 'hidden' : 'md:group-hover:hidden md:group-focus-within:hidden'}`} title={`最近活动：${new Date(p.session.lastActivityAt).toLocaleString()}\n本会话启动于：${new Date(p.session.startedAt).toLocaleString()}`}><span>{relTime(p.session.lastActivityAt)}</span></span>
            <div className={`items-center gap-0.5 ${rowBusy ? 'flex' : 'max-md:flex hidden group-hover:flex group-focus-within:flex'}`}>
            <button
              type="button"
              disabled={reloading || p.session.status === 'reconnecting'}
              aria-label={reloading ? `正在重载 session ${p.title}` : `重载 session ${p.title}`}
              title="重载此会话的扩展 / 技能 / 提示词（热刷新，无需重启进程）"
              onPointerDown={event => event.stopPropagation()}
              onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
              onClick={requestReload}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-2xs text-muted opacity-60 transition-opacity hover:bg-bg-hover hover:text-accent hover:opacity-100 disabled:opacity-40"
            >
              <MaterialIcon name="sync" spin={reloading} className="h-3.5 w-3.5" />
            </button>
            {/* Disabled is a real state, so it must LOOK disabled while the row is
                hovered: `group-hover:opacity-100` (specificity 0,3,0) otherwise beats
                `disabled:opacity-40` (0,2,0) and the button reads as clickable.
                The reason lives on the wrapper, because browsers do not reliably show
                `title` tooltips on disabled controls. */}
            <span className="flex shrink-0 items-center" title={p.restartDisabledReason ? `重启不可用：${p.restartDisabledReason}` : undefined}>
              <button
                type="button"
                disabled={restartPending || !!p.restartDisabledReason}
                aria-label={restartPending ? `正在重启 session ${p.title}` : restartArmed ? `确认重启 session ${p.title}` : `重启 session ${p.title}`}
                title={p.restartDisabledReason ? undefined : (restartPending ? '正在退出并恢复 Pi session…' : restartArmed ? '再点一次确认重启；未完成工作可能中断' : '重启 Pi 并恢复同一 session（需要二次确认）')}
                onPointerDown={event => event.stopPropagation()}
                onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
                onClick={requestRestart}
                className={`grid h-5 shrink-0 place-items-center rounded px-1 text-2xs transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${restartArmed ? 'bg-danger-subtle text-danger opacity-100' : restartPending ? 'text-muted opacity-100 cursor-wait' : 'text-muted opacity-50 enabled:hover:bg-accent-subtle enabled:hover:text-accent group-hover:opacity-100 group-hover:disabled:opacity-40 focus-visible:opacity-100'}`}
              ><MaterialIcon name="restore" spin={restartPending} className="h-3.5 w-3.5" />{restartArmed ? '确认' : ''}</button>
            </span>
            <span className="flex shrink-0 items-center" title={p.shutdownDisabledReason ? `退出不可用：${p.shutdownDisabledReason}` : undefined}>
              <button
                type="button"
                disabled={exitPending || !!p.shutdownDisabledReason}
                aria-label={exitPending ? `正在退出 session ${p.title}` : exitArmed ? `确认退出 session ${p.title}` : `退出 session ${p.title}`}
                title={p.shutdownDisabledReason ? undefined : (exitPending ? '正在安全关闭 Pi…' : exitArmed ? '再点一次确认退出 Pi（会中断未完成工作）' : '退出 Pi（通过专用关闭指令）')}
                onPointerDown={event => event.stopPropagation()}
                onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
                onClick={requestExit}
                className={`grid h-5 shrink-0 place-items-center rounded px-1 text-2xs transition-opacity disabled:cursor-not-allowed disabled:opacity-40 ${exitArmed ? 'bg-danger-subtle text-danger opacity-100' : exitPending ? 'text-muted opacity-100 cursor-wait' : 'text-muted opacity-50 enabled:hover:bg-danger-subtle enabled:hover:text-danger group-hover:opacity-100 group-hover:disabled:opacity-40 focus-visible:opacity-100'}`}
              >{exitPending ? '…' : exitArmed ? '确认' : '⏻'}</button>
            </span>
            <button
              type="button"
              aria-label={`设置 ${p.title} 的装扮`}
              title="设置会话装扮"
              onMouseDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); setAppearanceEditing(true) }}
              className="flex shrink-0 items-center rounded px-1 text-muted opacity-60 hover:bg-bg-hover hover:text-accent focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            ><MaterialIcon name="palette" className="h-3.5 w-3.5" /></button>
            {p.reorderMode && (
              <div className="flex shrink-0 items-center gap-0.5" onClick={event => event.stopPropagation()}>
                <button
                  type="button"
                  disabled={p.moveIndex <= 0}
                  aria-label={`上移 session ${p.title}`}
                  title="上移一位"
                  onClick={() => p.onMove('up')}
                  className="grid h-5 w-5 place-items-center rounded border border-border bg-bg text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-30"
                >↑</button>
                <button
                  type="button"
                  disabled={p.moveIndex >= p.moveCount - 1}
                  aria-label={`下移 session ${p.title}`}
                  title="下移一位"
                  onClick={() => p.onMove('down')}
                  className="grid h-5 w-5 place-items-center rounded border border-border bg-bg text-2xs text-muted hover:border-accent hover:text-accent disabled:opacity-30"
                >↓</button>
                <button
                  type="button"
                  aria-label={`${p.pinned ? '取消置顶' : '置顶'} session ${p.title}`}
                  title={p.pinned ? '取消置顶' : '置顶到第一位'}
                  onClick={() => p.onPin(!p.pinned)}
                  className={`grid h-5 w-5 place-items-center rounded border border-border bg-bg text-2xs ${p.pinned ? 'border-accent text-accent' : 'text-muted hover:text-accent'}`}
                >📌</button>
              </div>
            )}
            <button
              type="button"
              aria-label="Session menu"
              onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
              onClick={() => setMenuOpen(v => !v)}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition-opacity hover:bg-bg-hover hover:text-text-strong ${menuOpen ? 'bg-bg-hover text-text-strong opacity-100' : 'opacity-70 hover:opacity-100'}`}
            ><MaterialIcon name="more_horiz" className="h-4 w-4" /></button>
            </div>
          </div>

          {/* line 2 — status · tags · group · location */}
          <div className="flex h-[14px] items-center gap-1 overflow-hidden">
            <span className="flex min-w-0 shrink items-center gap-1 text-2xs leading-none text-muted-strong">
              {/* basename only: the full path stays in the row tooltip and the branch in `git.branch`. */}
              <LineIcon name="terminal" className="h-3 w-3" />
              <span className="min-w-0 truncate font-mono" title={cwd}>{projectName(cwd) || displayWorktreePath(cwd)}</span>
            </span>
            {p.childCount > 0 && <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-bg-hover px-1.5 text-2xs leading-[14px] text-muted-strong" title={`${p.childCount} 个子 Agent`}><LineIcon name="flow" className="h-3 w-3" />{p.childCount}</span>}
            {p.pinned && <span className="flex shrink-0 items-center text-accent" title="已置顶"><MaterialIcon name="push_pin" className="h-3.5 w-3.5" /></span>}
            {p.tmuxSession && <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-bg px-1.5 text-2xs leading-[14px] text-muted-strong" title={`终端可访问：tmux attach -t ${p.tmuxSession}`}><MaterialIcon name="terminal" className="h-3 w-3" />终端</span>}
            {p.subagent && <span className={`inline-flex shrink-0 items-center gap-0.5 text-2xs leading-none ${taskStatusClass(p.taskStatus)}`} title={`子 Agent 任务：${taskStatusLabel(p.taskStatus)}`}>{p.taskStatus === 'running' ? <MuyuIcon className="h-3 w-3" /> : <MaterialIcon name={taskStatusIcon(p.taskStatus)} className="h-3.5 w-3.5" />}子 Agent · {taskStatusLabel(p.taskStatus)}</span>}
            {(p.pendingUiCount ?? 0) > 0 && <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warn-subtle px-1.5 text-2xs leading-[14px] text-warn" title={`该会话有 ${p.pendingUiCount} 个待应答请求，agent 正在等待回答`}><MaterialIcon name="error" className="h-3 w-3" />待应答 {p.pendingUiCount}</span>}
            {/* Task anchor state. Sessions that never set a goal draw nothing — a "—"
                chip on every row would drown the ones that do carry a goal. A goal
                without a checklist still gets a chip: its state (进行中/已暂停) is
                what tells the user the loop is working on this session. */}
            {p.session.goal && (() => {
              const goal = p.session.goal
              const status = goal.status
              const statusLabel = status === 'active' ? '进行中' : status === 'paused' ? '已暂停' : status === 'complete' ? '已完成' : undefined
              const label = goal.total > 0 ? `${goal.done}/${goal.total}` : statusLabel
              if (!label) return null
              const complete = goal.total > 0 ? goal.done === goal.total && !goal.stale : status === 'complete'
              const working = status === 'active' && !goal.stale
              const paused = status === 'paused'
              const tone = goal.stale || goal.needsUser > 0 || paused
                ? 'bg-warn-subtle text-warn'
                : complete ? 'bg-ok-subtle text-ok' : 'bg-accent-subtle text-accent'
              const hint = [
                statusLabel ? `任务锚点：${statusLabel}` : `任务锚点：${goal.done}/${goal.total} 完成`,
                statusLabel && goal.total > 0 ? `${goal.done}/${goal.total} 完成` : '',
                working ? '会话会按间隔自动继续推进' : '',
                goal.needsUser > 0 ? `${goal.needsUser} 项需要你处理` : '',
                goal.stale ? '清单可能过期' : '',
              ].filter(Boolean).join('，')
              return <span
                data-session-goal={goal.stale ? 'stale' : paused ? 'paused' : complete ? 'complete' : 'active'}
                className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 text-2xs leading-[14px] ${tone}`}
                title={hint}
              >
                {working && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />}
                {paused && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />}
                {!working && !paused && (goal.stale || complete) && <MaterialIcon name={goal.stale ? 'error' : 'check'} className="h-3 w-3" />}
                {goal.stale ? '需核对' : label}
              </span>
            })()}
            {chips.map(t => <TagChip key={t} tag={t} active={p.tagFilter === t} onClick={p.onToggleTagFilter} />)}
            {extra > 0 && <span className="shrink-0 rounded-full bg-bg-hover px-1 text-2xs font-semibold leading-[14px] text-muted-strong" title={p.tags.join(', ')}>+{extra}</span>}
            {p.groupName && <span className="shrink-0 truncate rounded-full bg-ok-subtle px-1.5 text-2xs leading-[14px] text-ok" title={`任务分组：${p.groupName}`}>{p.groupName}</span>}
          </div>
        </div>
      </div>
      {p.dropAfter && <div aria-hidden className="pointer-events-none -mt-px h-[2px] rounded-full bg-accent" />}

      {tagEditing && <TagEditor tags={p.tags} allTags={p.allTags} onTags={p.onTags} onClose={() => setTagEditing(false)} />}
      {appearanceEditing && <SessionAppearanceDialog title={p.title} appearance={p.appearance} onSave={p.onAppearance} onRename={p.onRename} onClose={() => setAppearanceEditing(false)} />}
      {menuOpen && <RowMenu items={items} up={p.up} ariaLabel={`Session actions for ${p.title}`} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

/**
 * One row of the task-group admin list.
 *
 * Empty groups never render a sidebar section (a section with no rows is
 * filtered out), so without this list a duplicated “hold” can neither be seen
 * nor removed. Rename / merge / delete only touch the group — running sessions
 * keep going.
 */
function GroupAdminRow({ group, groups, busy, onRename, onMerge, onDelete }: {
  group: LiveSessionGroup
  groups: LiveSessionGroup[]
  busy: boolean
  onRename: (name: string) => void
  onMerge: (targetId: string) => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(group.name)
  const [merging, setMerging] = useState(false)
  const [target, setTarget] = useState('')
  const [armed, setArmed] = useState(false)
  const others = groups.filter(candidate => candidate.id !== group.id)
  const count = group.sessionIds.length

  const submitRename = () => {
    const name = draft.trim()
    setRenaming(false)
    if (name && name !== group.name) onRename(name)
  }

  return (
    <div data-group-admin={group.id} className="rounded border border-border bg-card px-1.5 py-1">
      <div className="flex items-center gap-1">
        {renaming ? (
          <input
            autoFocus
            aria-label={`重命名分组 ${group.name}`}
            value={draft}
            maxLength={120}
            onChange={event => setDraft(event.target.value)}
            onBlur={submitRename}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); submitRename() }
              else if (event.key === 'Escape') { event.preventDefault(); setRenaming(false) }
            }}
            className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-2xs text-text-strong outline-none"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-2xs font-semibold text-text-strong" title={group.name}>{group.name}</span>
        )}
        <span className="shrink-0 rounded-full bg-bg-hover px-1.5 font-mono text-2xs leading-[14px] text-muted-strong" title={`${count} 个 session`}>{count || '空'}</span>
        <button type="button" disabled={busy} aria-label={`重命名分组 ${group.name}`} title="重命名" onClick={() => { setDraft(group.name); setRenaming(true) }} className="flex shrink-0 items-center rounded px-1 text-muted opacity-70 transition-opacity hover:bg-bg-hover hover:text-accent hover:opacity-100 disabled:opacity-40"><MaterialIcon name="edit" className="h-3.5 w-3.5" /></button>
        <button
          type="button"
          disabled={busy || others.length === 0}
          aria-label={`合并分组 ${group.name}`}
          title={others.length === 0 ? '只有一个分组，没有可合并的目标' : '把本组 session 移到另一个分组，然后删除本组'}
          onClick={() => { setMerging(value => !value); setTarget('') }}
          className="flex shrink-0 items-center rounded px-1 text-muted opacity-70 transition-opacity hover:bg-bg-hover hover:text-accent hover:opacity-100 disabled:opacity-40"
        ><MaterialIcon name="call_merge" className="h-3.5 w-3.5" /></button>
        <button
          type="button"
          disabled={busy}
          aria-label={`删除分组 ${group.name}`}
          title={armed ? '再点一次确认删除（session 不会被删除）' : '删除分组（session 不会被删除）'}
          onClick={() => { if (armed) { setArmed(false); onDelete() } else setArmed(true) }}
          className={armed ? 'flex shrink-0 items-center rounded bg-danger-subtle px-1.5 py-0.5 text-2xs font-semibold text-danger disabled:opacity-40' : 'flex shrink-0 items-center rounded px-1 text-muted opacity-70 transition-opacity hover:bg-danger-subtle hover:text-danger hover:opacity-100 disabled:opacity-40'}
        >{armed ? '确认删除' : <MaterialIcon name="close" className="h-3.5 w-3.5" />}</button>
      </div>
      {merging && (
        <div className="mt-1 flex items-center gap-1">
          <select aria-label={`合并 ${group.name} 到`} value={target} onChange={event => setTarget(event.target.value)} className="min-w-0 flex-1 rounded border border-border bg-bg px-1 py-0.5 text-2xs text-text outline-none">
            <option value="">合并到…</option>
            {others.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}（{candidate.sessionIds.length} 个 session）</option>)}
          </select>
          <button type="button" disabled={busy || !target} onClick={() => { setMerging(false); onMerge(target) }} className="shrink-0 rounded border border-border bg-bg px-1.5 py-0.5 text-2xs text-muted transition hover:border-accent hover:text-accent disabled:opacity-50">确认合并</button>
        </div>
      )}
    </div>
  )
}

export default function LiveSessionsList({ sessions, sessionTitles = {}, subagentStatuses = {}, activeId, onSelect, onRefresh, pendingUiCounts = {} }: LiveSessionsListProps) {
  const [reorderMode, setReorderMode] = useState(false)
  const [groups, setGroups] = useState<LiveSessionGroup[]>([])
  const [creating, setCreating] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [starting, setStarting] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [startCwd, setStartCwd] = useState('')
  const [recentStartPaths, setRecentStartPaths] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('pi-dashboard:live-session-start-paths') || '[]')
      return Array.isArray(saved) ? saved.filter((path): path is string => typeof path === 'string').slice(0, START_PATH_HISTORY_KEEP) : []
    } catch { return [] }
  })
  /** Repos under `liveSessions.repoRoots`; refreshed whenever the start form opens. */
  const [repoCandidates, setRepoCandidates] = useState<RepoCandidate[]>([])
  const [startGroupId, setStartGroupId] = useState('')
  const [startTags, setStartTags] = useState('')
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
  const [sessionActionNotice, setSessionActionNotice] = useState<{ text: string; danger: boolean } | null>(null)
  /** processInstanceId of the session whose "从此分叉" launch is in flight. */
  const [forkingId, setForkingId] = useState<string | null>(null)
  const [forkError, setForkError] = useState<string>()
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [armedGroup, setArmedGroup] = useState<string | null>(null)
  const { meta, allTags, tagCounts, patch, refresh: refreshMeta, error: metaError } = useLiveSessionMeta()
  const { order, sectionOrder, savingSections, saveSections, save: saveOrder, reset: resetOrder, refresh: refreshOrder, error: orderError } = useLiveSessionOrder()
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  useEffect(() => { setCollapsedSections({}) }, [filter, tagFilter])
  const orderedSectionIds = useMemo(() => sectionOrderIds(groups, sectionOrder), [groups, sectionOrder])
  const moveSection = (id: string, direction: 'up' | 'down' | 'bottom') => {
    const index = orderedSectionIds.indexOf(id)
    const next = orderedSectionIds.filter(candidate => candidate !== id)
    next.splice(direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : next.length, 0, id)
    void saveSections(next)
  }

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
  const reloadAllConfirm = useArmedConfirm()
  const reloadAllSessions = () => {
    if (reloadingAll) return
    const targets = sessions.filter(session => session.role !== 'subagent')
    if (targets.length === 0) {
      setReloadNotice({ text: '没有可重载的主会话（子 Agent 进程会被跳过）', danger: false })
      return
    }
    // Armed instead of window.confirm: browsers answer a suppressed confirm with a
    // silent `false`, which made this button look dead.
    if (!reloadAllConfirm.confirm()) {
      setReloadNotice({ text: `再点一次「重载全部」确认：${targets.length} 个主会话的 Pi 进程会重新加载扩展 / 技能 / 提示词 / 主题`, danger: false })
      return
    }
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

  useEffect(() => {
    if (!sessionActionNotice) return
    const timer = window.setTimeout(() => setSessionActionNotice(null), 8_000)
    return () => window.clearTimeout(timer)
  }, [sessionActionNotice])

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

  // Repo list for the cwd field's keyword search. A dashboard without
  // `liveSessions.repoRoots` simply returns none — not worth an error banner.
  useEffect(() => {
    if (!startOpen) return
    let cancelled = false
    liveSessionApi.repoCandidates()
      .then(repos => { if (!cancelled) setRepoCandidates(repos) })
      .catch(() => { if (!cancelled) setRepoCandidates([]) })
    return () => { cancelled = true }
  }, [startOpen])

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
    let result: Awaited<ReturnType<typeof liveSessionApi.start>>
    try {
      result = await liveSessionApi.start({ cwd: startCwd.trim(), ...(startModel.trim() ? { model: startModel.trim() } : {}), thinkingLevel: startThinking, ...(startTitle.trim() ? { title: startTitle.trim() } : {}) })
    } catch (reason) {
      setStartError(formatStartError(reason instanceof Error ? reason.message : String(reason)))
      setStarting(false)
      return
    }

    const cwd = startCwd.trim()
    const paths = [cwd, ...recentStartPaths.filter(path => path !== cwd)].slice(0, START_PATH_HISTORY_KEEP)
    setRecentStartPaths(paths)
    try { localStorage.setItem('pi-dashboard:live-session-start-paths', JSON.stringify(paths)) } catch { /* session storage is a convenience only */ }
    try {
      if (result.processInstanceId && result.sessionId) {
        if (startGroupId) setGroups(await liveSessionApi.addGroupMember(startGroupId, result.processInstanceId))
        const tags = [...new Set(startTags.split(',').map(tag => tag.trim()).filter(Boolean))]
        if (tags.length) await patch(result.processInstanceId, result.sessionId, { tags })
      }
    } catch (reason) {
      setStartError(`Pi 已启动，但分组或标签未能保存：${reason instanceof Error ? reason.message : String(reason)}`)
    }
    setStartCwd('')
    setStartModel('')
    setStartTitle('')
    setStartTags('')
    setStartGroupId('')
    setStarting(false)
    setStartOpen(false)
    window.setTimeout(() => { void onRefresh?.() }, 1_000)
  }

  const groupOf = useCallback((session: LiveSessionSummary): LiveSessionGroup | undefined => groupOfSession(session, groups), [groups])

  /** Directories this browser started a Live Pi in, most recent first. */
  const startPathHistory = useMemo(
    () => mergeStartPathHistory(recentStartPaths, sessions.map(session => session.canonicalCwd)),
    [recentStartPaths, sessions],
  )

  /** Repos discovered under `liveSessions.repoRoots`, minus the ones history already shows. */
  const startPathRepos = useMemo(() => {
    const known = new Set(startPathHistory)
    return repoCandidates.map(candidate => candidate.path).filter(path => !known.has(path))
  }, [repoCandidates, startPathHistory])

  /** History plus discovered repos: everything a typed keyword and Tab may choose. */
  const startPathCandidates = useMemo(
    () => [...startPathHistory, ...startPathRepos],
    [startPathHistory, startPathRepos],
  )

  /** What the field typed so far matches: keyword hits first, recency when empty. */
  const startPathSuggestions = useMemo(
    () => matchStartPaths(startPathCandidates, startCwd.trim()),
    [startPathCandidates, startCwd],
  )

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

  const sections = useMemo<SessionSection[]>(() => buildSessionSections(visible, meta, groups, order, sectionOrder), [visible, groups, meta, order, sectionOrder])

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

  const rowHandlers = (session: LiveSessionSummary) => ({
    onPin: (pinned: boolean) => void patch(session.processInstanceId, session.sessionId, { pinned }),
    onTags: (tags: string[]) => void patch(session.processInstanceId, session.sessionId, { tags }),
    onAppearance: async (appearance: SessionAppearance) => {
      if (!await patch(session.processInstanceId, session.sessionId, appearance)) {
        throw new Error('装扮保存失败，请检查连接后重试。')
      }
    },
    onRename: (name: string) => { void liveSessionApi.rename(session.processInstanceId, name).then(() => onRefresh?.()) },
    onFork: () => { void forkSession(session) },
    onJoinGroup: (groupId: string) => void mutateGroups(() => liveSessionApi.addGroupMember(groupId, session.processInstanceId)),
    onLeaveGroup: (groupId: string) => void mutateGroups(() => liveSessionApi.removeGroupMember(groupId, session.sessionId)),
    onCopySessionId: () => { void navigator.clipboard?.writeText(session.sessionId).catch(() => {}) },
    onCopyTerminalCommand: () => {
      const tmux = meta[session.sessionId]?.tmux
      if (tmux) void navigator.clipboard?.writeText(`tmux attach -t ${tmux}`).catch(() => {})
    },
    onExitSession: async () => {
      try {
        await liveSessionApi.command(session.processInstanceId, { type: 'shutdown' })
        setSessionActionNotice({ text: `已发送退出指令：${sessionTitle(session, sessionTitles)}`, danger: false })
        if (onRefresh) void onRefresh().catch(() => {})
      } catch (reason) {
        setSessionActionNotice({ text: `退出失败：${reason instanceof Error ? reason.message : String(reason)}`, danger: true })
        throw reason
      }
    },
    // tmux-first live sessions are closed by killing their tmux session; the Pi
    // inside it exits with the pane and the sidebar row disappears on its own.
    onRestartSession: async () => {
      try {
        const result = await liveSessionApi.restart(session.processInstanceId)
        setSessionActionNotice({ text: `已重启「${sessionTitle(session, sessionTitles)}」，正在恢复原 session`, danger: false })
        if (activeId === session.processInstanceId && result.processInstanceId) onSelect(result.processInstanceId)
        if (onRefresh) window.setTimeout(() => { void onRefresh().catch(() => {}) }, 250)
      } catch (reason) {
        setSessionActionNotice({ text: `重启失败：${reason instanceof Error ? reason.message : String(reason)}`, danger: true })
      }
    },
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
    const renderRow = (session: LiveSessionSummary, index: number, depth = 0) => {
      const group = groupOf(session)
      const subagent = isSubagent(session)
      const childCount = childrenByParent.get(session.sessionId) || 0
      const shutdownDisabledReason = session.mode !== 'tui'
        ? '目前只支持 TUI session'
        : !session.capabilities?.includes('session_shutdown')
          ? '当前 Pi bridge 不支持安全关闭，请手动重启一次后再试'
          : undefined
      const restartDisabledReason = subagent
        ? '子 Agent 不支持单独重启'
        : session.mode !== 'tui'
          ? '目前只支持 TUI session'
          : session.status === 'running'
            ? '请等 Pi 空闲后再重启'
          : !meta[session.sessionId]?.tmux
            ? '仅支持 dashboard 管理的 tmux session'
            : !session.sessionFile
              ? '没有可恢复的 session 文件'
              : session.status === 'reconnecting'
                ? 'session 正在重连，请稍后再试'
                : childCount > 0
                  ? '请先完成该 session 的子 Agent'
                  : undefined
      return (
        <SessionRow
          key={session.processInstanceId}
          session={session}
          title={sessionTitle(session, sessionTitles)}
          depth={depth}
          blockId={section.id}
          dragging={dragActive && drag?.sessionId === session.sessionId}
          dropBefore={target !== undefined && anchors.indexOf(session.sessionId) === target}
          dropAfter={target !== undefined && target === anchors.length && index === items.length - 1}
          onDragStart={event => { if (!subagent) beginDrag(session, event) }}
          onMove={place => { if (!subagent) moveRow(session, place) }}
          moveIndex={subagent ? 0 : index}
          moveCount={subagent ? 1 : items.length}
          active={activeId === session.processInstanceId}
          groupName={group?.name}
          groupId={group?.id}
          childCount={childCount}
          subagent={subagent}
          restartDisabledReason={restartDisabledReason}
          shutdownDisabledReason={shutdownDisabledReason}
          taskStatus={subagent && session.subagentWorkId ? subagentStatuses[session.subagentWorkId] : undefined}
          tags={meta[session.sessionId]?.tags || []}
          pinned={!!meta[session.sessionId]?.pinned}
          appearance={meta[session.sessionId]}
          pendingUiCount={pendingUiCounts[session.processInstanceId]}
          tagFilter={tagFilter}
          allTags={allTags}
          groups={groups}
          up={index >= items.length - 2}
          busy={busy}
          reorderMode={reorderMode}
          onSelect={() => selectRow(session)}
          tmuxSession={meta[session.sessionId]?.tmux}
          onToggleTagFilter={tag => setTagFilter(current => current === tag ? null : tag)}
          {...rowHandlers(session)}
        />
      )
    }
    return items.map((session, index) => {
      const children = visible.filter(child => isSubagent(child) && child.parentSessionId === session.sessionId)
      return <div key={session.processInstanceId}>
        {renderRow(session, index)}
        {children.length > 0 && <details className="ml-4" open={children.some(child => child.processInstanceId === activeId) ? true : undefined}>
          <summary className="cursor-pointer rounded px-2 py-1 text-2xs text-muted hover:bg-bg-hover">子助手 · {children.length}</summary>
          {children.map((child, childIndex) => renderRow(child, childIndex, 1))}
        </details>}
      </div>
    })
  }
  const mainSessionIds = new Set(sections.flatMap(section => section.sessions.map(session => session.sessionId)))
  const unassociatedSubagents = visible.filter(session => isSubagent(session) && !mainSessionIds.has(session.parentSessionId || ''))
  const mainCount = sessions.filter(session => !isSubagent(session)).length
  const visibleMainCount = visible.filter(session => !isSubagent(session)).length

  return (
    <aside className={`pidash-sidebar flex w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-accent md:w-[320px] ${dragActive ? 'select-none' : ''}`}>
      <div className="sticky top-0 z-10 border-b border-border bg-bg-accent px-3 py-2.5">
        <div className="flex items-center gap-1">
          <h1 className="min-w-0 flex-1 text-title font-semibold text-text-strong">
            会话
            <span className="ml-1.5 rounded-full bg-bg-hover px-1.5 py-px font-mono text-2xs font-normal text-muted-strong">
              {visibleMainCount === mainCount ? mainCount : `${visibleMainCount}/${mainCount}`}
            </span>
          </h1>
          <button
            type="button"
            disabled={reloadingAll}
            onClick={reloadAllSessions}
            aria-label={reloadAllConfirm.armed ? '确认重载' : '重载全部'}
            className={`flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-2xs transition disabled:opacity-50 ${reloadAllConfirm.armed ? 'bg-danger-subtle font-semibold text-danger' : 'text-muted hover:bg-bg-hover hover:text-accent'}`}
            title={reloadAllConfirm.armed ? '再点一次确认重载全部' : '重载所有会话：让每个 Pi 进程重新加载扩展 / 技能 / 提示词 / 主题（子 Agent 进程跳过）'}
          ><LineIcon name="refresh" className={`h-4 w-4 ${reloadingAll ? 'animate-spin' : ''}`} />{reloadAllConfirm.armed && '确认'}</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setReorderMode(value => !value)}
            aria-label={reorderMode ? '完成排序' : '调整排序'}
            aria-pressed={reorderMode}
            className={`flex h-7 shrink-0 items-center justify-center gap-0.5 rounded-md px-1.5 text-2xs transition ${reorderMode ? 'bg-accent font-medium text-accent-fg' : 'text-muted hover:bg-bg-hover hover:text-text'}`}
            title={reorderMode ? '完成排序模式' : '调整会话上下显示次序（手机端与桌面端均可一键上下移动）'}
          >
            <MaterialIcon name="swap_vert" className="h-4 w-4" />
            {reorderMode && <span className="text-2xs">完成</span>}
          </button>
          <button type="button" aria-label="任务" disabled={busy || starting} onClick={() => setCreating(value => !value)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-bg-hover hover:text-text disabled:opacity-50" title="新建 / 管理任务分组"><LineIcon name="folder" className="h-4 w-4" /></button>
          <button type="button" aria-label="启动" disabled={busy || starting} onClick={() => { setStartError(undefined); setStartOpen(value => !value) }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-accent transition hover:opacity-80 disabled:opacity-50" title="启动一个新的 Live Pi"><LineIcon name="plus" className="h-4 w-4" /></button>
        </div>

        <div className="relative mt-2">
          <span className="pointer-events-none absolute left-2.5 top-1/2 flex -translate-y-1/2 text-muted" aria-hidden="true"><LineIcon name="search" className="h-3.5 w-3.5" /></span>
          <input
            type="search"
            className="w-full rounded-md border border-border bg-card py-1 pl-8 pr-3 text-body-s text-text outline-none transition placeholder:text-muted focus:border-accent"
            placeholder="搜索 session / 目录 / 标签…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>

        {reloadNotice && <div role="status" aria-label="重载结果" className={`mt-1.5 text-2xs ${reloadNotice.danger ? 'text-danger' : 'text-muted-strong'}`}>{reloadNotice.text}</div>}
        {sessionActionNotice && <div role="status" aria-label="会话操作结果" className={`mt-1.5 text-2xs ${sessionActionNotice.danger ? 'text-danger' : 'text-muted-strong'}`}>{sessionActionNotice.text}</div>}

        {tagCounts.length > 0 && (
          <div className="mt-2 flex items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" onClick={() => setTagFilter(null)}
              className={`shrink-0 rounded-full border px-2 py-px text-2xs font-medium leading-[16px] ${!tagFilter ? 'border-border-strong bg-bg-hover text-text-strong' : 'border-transparent text-muted hover:text-text'}`}>全部</button>
            {tagCounts.slice(0, 12).map(({ tag, count }) => (
              <button
                key={tag}
                type="button"
                title={`#${tag} · ${count} 个 session`}
                onClick={() => setTagFilter(current => current === tag ? null : tag)}
                className={`inline-flex max-w-[96px] shrink-0 items-center gap-1 truncate rounded-full border px-2 py-px text-2xs font-medium leading-[16px] ${tagColorClass(tag)} ${tagFilter === tag ? 'ring-1 ring-accent' : 'opacity-90 hover:opacity-100'}`}
              ><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{tag}</button>
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
                  // A keyword (not a path) that matches exactly one candidate —
                  // a directory we started before, or a repo under the configured
                  // repo roots — is filled in directly. Anything else opens the menu.
                  const typed = startCwd.trim()
                  const keywordHits = isPathLikeQuery(typed) ? [] : matchStartPaths(startPathCandidates, typed, 2)
                  if (keywordHits.length === 1 && keywordHits[0] !== typed) {
                    const filled = `${keywordHits[0]}/`
                    setStartCwd(filled)
                    setStartCwdCursor(filled.length)
                    setStartCwdMenuOpen(false)
                    return
                  }
                  setStartCwdCursor(startCwdRef.current?.selectionStart ?? 0)
                  setStartCwdMenuOpen(true)
                } else if (event.key === 'Escape') setStartCwdMenuOpen(false)
              }}
              placeholder="工作目录，例如 ~/repos/...（Tab 补全）"
              className="w-full rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none focus:border-accent"
            />
            {startPathSuggestions.length > 0 && <div className="flex flex-wrap gap-1" aria-label="常用工作目录">
              {startPathSuggestions.map(path => <button key={path} type="button" onClick={() => setStartCwd(path)} title={path} className="max-w-full truncate rounded-full border border-border px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-text">{path}</button>)}
            </div>}
            <div className="text-2xs leading-[15px] text-muted-strong">
              必须是<b>已存在</b>的绝对目录（或 <span className="font-mono">~/…</span>），且在白名单根目录内。输入关键词（如 <span className="font-mono">toolkit</span>）会从用过的目录和仓库根目录下的现有仓库里匹配，按 Tab 可直接补全。
            </div>
            {startCwdMenuOpen && <PathCompleteMenu
              input={startCwd}
              cursorPos={startCwdCursor}
              anchorRef={startCwdRef}
              history={startPathHistory}
              repos={startPathRepos}
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
            <select aria-label="启动后加入分组" value={startGroupId} onChange={event => setStartGroupId(event.target.value)} className="w-full rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none">
              <option value="">不加入分组</option>
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <input value={startTags} onChange={event => setStartTags(event.target.value)} placeholder="标签（可选，逗号分隔）" className="w-full rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none focus:border-accent" />
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
            {startError && <div className="whitespace-pre-wrap break-words text-2xs text-danger">{startError.startsWith('Pi 已启动') ? '' : '启动失败：'}{startError}</div>}
          </form>}
          {creating && <div className="space-y-1.5 border-t border-border pt-2">
            <div className="space-y-1" aria-label="分组顺序" aria-busy={savingSections}>
              <div className="text-2xs text-muted">分组顺序（置顶会话始终在最前）</div>
              {orderedSectionIds.map((id, index) => {
                const name = groups.find(group => group.id === id)?.name ?? '未分组'
                return <div key={id} className="flex items-center gap-1 text-2xs">
                  <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
                  <button type="button" disabled={busy || savingSections || index === 0} aria-label={`${name}：上移分组`} onClick={() => moveSection(id, 'up')} className="rounded border border-border px-1.5 py-0.5 hover:bg-bg-hover disabled:opacity-30">↑</button>
                  <button type="button" disabled={busy || savingSections || index === orderedSectionIds.length - 1} aria-label={`${name}：下移分组`} onClick={() => moveSection(id, 'down')} className="rounded border border-border px-1.5 py-0.5 hover:bg-bg-hover disabled:opacity-30">↓</button>
                  <button type="button" disabled={busy || savingSections || index === orderedSectionIds.length - 1} aria-label={`${name}：移到底部`} onClick={() => moveSection(id, 'bottom')} className="rounded border border-border px-1.5 py-0.5 hover:bg-bg-hover disabled:opacity-30">移到底部</button>
                </div>
              })}
            </div>
            <form onSubmit={event => { void createGroup(event) }} className="flex gap-1">
              <input value={newGroupName} onChange={event => setNewGroupName(event.target.value)} placeholder="新建任务分组名称" className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-2xs text-text outline-none focus:border-accent" />
              <button type="submit" disabled={busy || !newGroupName.trim()} className="rounded border border-border px-2 py-1 text-2xs text-muted disabled:opacity-50">创建</button>
            </form>
            {groups.length > 0 && (
              <div>
                <div className="flex items-baseline justify-between gap-1 text-2xs">
                  <span className="font-semibold text-muted">已有分组 <span className="font-normal text-muted-strong">（含没有 session 的空分组）</span></span>
                  <span className="shrink-0 text-muted-strong">不会动到 session</span>
                </div>
                <div className="mt-1 space-y-1">
                  {groups.map(group => (
                    <GroupAdminRow
                      key={group.id}
                      group={group}
                      groups={groups}
                      busy={busy}
                      onRename={name => void mutateGroups(() => liveSessionApi.renameGroup(group.id, name))}
                      onMerge={targetId => void mutateGroups(() => liveSessionApi.mergeGroup(group.id, targetId))}
                      onDelete={() => void mutateGroups(() => liveSessionApi.deleteGroup(group.id))}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>}
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
      ) : sections.length === 0 && unassociatedSubagents.length === 0 ? (
        <div className="p-5 text-meta text-muted-strong">没有匹配的 session{filter || tagFilter ? '（清除筛选试试）' : ''}</div>
      ) : sections.map((section, sectionIndex) => {
        const collapsed = collapsedSections[section.id] ?? (isHoldGroup(section.name) && !filter && !tagFilter)
        return (
        <section key={section.id} data-live-block={section.id} className={`live-session-section mx-1.5 my-1.5 rounded-lg pb-0.5 ${SECTION_TINTS[sectionIndex % SECTION_TINTS.length]}`}>
          <div className="group/section flex min-h-5 items-center gap-1 px-2.5 py-px">
            <button
              type="button"
              aria-label={`${section.name}：${collapsed ? '展开' : '折叠'}分组`}
              aria-expanded={!collapsed}
              onClick={() => setCollapsedSections(previous => ({ ...previous, [section.id]: !collapsed }))}
              className={`flex h-[18px] shrink-0 items-center rounded hover:bg-bg-hover ${section.pinnedSection ? 'text-accent' : 'text-muted-strong'}`}
            ><MaterialIcon name="expand_more" className={`h-3 w-3 ${collapsed ? '-rotate-90' : ''}`} /></button>
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
              <strong className="min-w-0 flex-1 truncate text-2xs font-medium text-muted-strong" title={section.name}>{section.name}</strong>
            )}
            <span className="shrink-0 font-mono text-2xs text-muted">{section.sessions.length}</span>
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
          {!collapsed && <div className="live-session-section-rows pb-px">{renderRows(section)}</div>}
        </section>
        )
      })}

      {unassociatedSubagents.length > 0 && <section aria-label="未关联子助手" className="border-b border-border px-2 py-2">
        <div className="px-2 py-1 text-2xs font-semibold text-muted">未关联子助手 · {unassociatedSubagents.length}</div>
        {renderRows({ id: '__unassociated_subagents', name: '未关联子助手', sessions: unassociatedSubagents })}
      </section>}
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
        {metaError !== undefined && <button type="button" className="ml-1 text-danger underline" onClick={() => void refreshMeta()}>· 会话设置同步失败，点击重试</button>}
      </div>
    </aside>
  )
}
