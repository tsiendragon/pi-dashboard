import { useState, useRef, useEffect, memo } from 'react'
import { useAppDispatch } from '../store'
import { switchSlot, deleteSlot } from '../store/chatSlice'
import { sseSlotTitle, sseSlotPinned, fetchSlots } from '../store/dashboardSlice'
import { api } from '../api/client'
import { SearchInput } from '../components/ui'
import InfoTip from '../components/InfoTip'
import TypewriterText from '../components/TypewriterText'
import WorkingHammerIcon from '../components/WorkingHammerIcon'
import {
  type SlotMeta, projectName, visibleTags,
  relTime, slotOrder, tagCounts,
} from './chat/sessionMeta'
import { TagChip, TagEditor, RowMenu, type RowMenuItem } from '../components/sessionMetaUi'

type Slot = SlotMeta
type GroupMode = 'date' | 'project' | 'status' | 'tag'

const STATUS_ORDER: Record<string, number> = { 'Needs Input': 0, 'Running': 1, 'Idle': 2 }
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 800
const SIDEBAR_LS_KEY = 'mc-sidebar-width'
const SLOTS_GROUP_LS_KEY = 'mc-slots-group-mode'
const COLLAPSED_GROUPS_LS_KEY = 'mc-collapsed-groups'
const TEMPORAL_ORDER: Record<string, number> = { Today: 0, Yesterday: 1, 'Last 7 Days': 2, 'Last 30 Days': 3 }
const UNTAGGED = 'untagged'
const PINNED_GROUP = 'Pinned'
const MAX_TAG_CHIPS = 2

// ─────────────────────────── grouping ───────────────────────────

interface Group<T> { key: string; items: T[] }

function groupBy<T>(items: T[], keyFn: (item: T) => string): Group<T>[] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = keyFn(item)
    const arr = map.get(k)
    if (arr) arr.push(item); else map.set(k, [item])
  }
  return Array.from(map.entries()).map(([key, items]) => ({ key, items }))
}

/** iOS-like time buckets: Today, Yesterday, Last 7 Days, Last 30 Days, then months. */
function temporalGroupLabel(dateStr?: string): string {
  if (!dateStr) return 'Unknown'
  const date = new Date(dateStr)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000)
  const ts = date.getTime()
  if (ts >= startOfToday.getTime()) return 'Today'
  if (ts >= startOfYesterday.getTime()) return 'Yesterday'
  const daysAgo = Math.floor((startOfToday.getTime() - ts) / 86400000)
  if (daysAgo <= 7) return 'Last 7 Days'
  if (daysAgo <= 30) return 'Last 30 Days'
  return date.toLocaleDateString([], { month: 'long', year: 'numeric' })
}

function statusOf(s: Slot): 'Needs Input' | 'Running' | 'Idle' {
  if (s.pending_approval && !s.stopping) return 'Needs Input'
  return s.running ? 'Running' : 'Idle'
}

/** Primary (first human) tag only — a multi-tag slot must not be listed twice. */
function primaryTag(s: Slot): string { return visibleTags(s.tags)[0] || UNTAGGED }

function sorterFor(mode: GroupMode): (s: Slot) => string {
  if (mode === 'status') return statusOf
  if (mode === 'date') return s => temporalGroupLabel(s.created)
  if (mode === 'tag') return primaryTag
  return s => projectName(s.cwd)
}

function sortGroups<T extends Slot>(groups: Group<T>[], mode: GroupMode): Group<T>[] {
  const out = groups.map(g => ({ ...g, items: [...g.items].sort(slotOrder) }))
  if (mode === 'status') {
    return out.sort((a, b) => (STATUS_ORDER[a.key] ?? 99) - (STATUS_ORDER[b.key] ?? 99))
  }
  if (mode === 'date') {
    return out.sort((a, b) => {
      const oa = TEMPORAL_ORDER[a.key] ?? 100, ob = TEMPORAL_ORDER[b.key] ?? 100
      if (oa !== ob) return oa - ob
      return new Date(b.key + ' 1').getTime() - new Date(a.key + ' 1').getTime()
    })
  }
  if (mode === 'tag') {
    return out.sort((a, b) => (a.key === UNTAGGED ? 1 : b.key === UNTAGGED ? -1 : b.items.length - a.items.length || a.key.localeCompare(b.key)))
  }
  return out.sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key))
}

/**
 * Pinned slots always form the leading group; the rest follow the chosen mode.
 * Keeping pin orthogonal to the modes means it survives every group/filter.
 */
function buildGroups(slots: Slot[], mode: GroupMode): Group<Slot>[] {
  const pinned = slots.filter(s => s.pinned).sort(slotOrder)
  const rest = slots.filter(s => !s.pinned)
  const out: Group<Slot>[] = []
  if (pinned.length) out.push({ key: PINNED_GROUP, items: pinned })
  out.push(...sortGroups(groupBy(rest, sorterFor(mode)), mode))
  return out
}

// ─────────────────────────── row ───────────────────────────

interface RowProps {
  slot: Slot
  active: boolean
  unread: boolean
  /** Hide the project meta when the list is already grouped by project. */
  showProject: boolean
  tagFilter: string | null
  /** Bottom of the list → open the menu upward so it stays visible. */
  up: boolean
  allTags: string[]
  onActivate: () => void
  onToggleTagFilter: (tag: string) => void
  onPin: (pinned: boolean) => void
  onNewInDir: () => void
  onClose: () => void
  onRename: (title: string) => void
  onTags: (tags: string[]) => void
}

function SlotRow(p: RowProps) {
  const s = p.slot
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [tagEditing, setTagEditing] = useState(false)
  const [renameValue, setRenameValue] = useState(s.title)

  const status = statusOf(s)
  const tags = visibleTags(s.tags)
  const chips = tags.slice(0, MAX_TAG_CHIPS)
  const extra = tags.length - chips.length
  const proj = projectName(s.cwd)
  const label = s.title !== s.key ? s.title : s.key

  const menuItems: RowMenuItem[] = [
    { label: '✎ 重命名', onClick: () => { setRenameValue(s.title); setRenaming(true) } },
    { label: '🏷 标签', onClick: () => setTagEditing(true) },
    { separator: true },
    { label: s.pinned ? '📌 取消置顶' : '📌 置顶', onClick: () => p.onPin(!s.pinned) },
    ...(s.cwd ? [{ label: '＋ 在此目录新建', onClick: p.onNewInDir, hint: proj || s.cwd || '' }] : []),
    { separator: true },
    { label: '✕ 关闭会话', confirmLabel: '再点一次确认关闭', danger: true, onClick: p.onClose },
  ]

  const submitRename = (commit: boolean) => {
    const v = renameValue.trim()
    setRenaming(false)
    if (commit && v && v !== s.title) p.onRename(v)
  }

  return (
    <div className="relative">
      <div
        role="button"
        tabIndex={0}
        aria-current={p.active || undefined}
        data-pidash-slot-status={status === 'Needs Input' ? 'attention' : s.running ? 'busy' : 'idle'}
        title={label}
        onMouseDown={e => e.preventDefault()}
        onClick={p.onActivate}
        onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onActivate() } }}
        className={`pidash-slot-item group flex cursor-pointer gap-2 rounded-md px-1.5 py-1.5 transition-colors ${p.active ? 'bg-accent-subtle' : 'hover:bg-bg-hover'}`}
      >
        {/* status rail — replaces the old full-width ⚠ pill so rows stay equal height */}
        <span className={`w-[2px] shrink-0 self-stretch rounded-full ${
          status === 'Needs Input' ? 'bg-warn shadow-[0_0_7px_var(--warn)]'
            : s.stopping ? 'bg-danger'
              : s.running ? 'bg-accent shadow-[0_0_7px_var(--accent-glow)]'
                : p.unread ? 'bg-info' : 'bg-transparent'
        }`} />

        {/* status gutter — the running glyph spans both text lines so the swing
            has room; other status glyphs stay on the title line */}
        <span className="flex w-[26px] shrink-0 items-stretch justify-center self-stretch text-body-s leading-none">
          {status === 'Needs Input' && <span role="status" title="Waiting for approval" aria-label="状态：等待输入" className="flex h-[18px] w-full items-center justify-center text-body-s leading-none">⚠️</span>}
          {s.stopping && <span role="status" title="Stopping" aria-label="状态：停止中" className="flex h-[18px] w-full items-center justify-center text-2xs leading-none">■</span>}
          {s.running && status !== 'Needs Input' && !s.stopping && (p.active
            ? <span className="flex h-[18px] w-full items-center justify-center"><span className="typing-dots-sm"><span /><span /><span /></span></span>
            : <span role="status" title="Running" aria-label="状态：工作中" className="flex w-full items-center justify-center"><WorkingHammerIcon className="working-hammer-row" /></span>)}
          {status === 'Idle' && !s.stopping && !p.unread && <span title="Idle" aria-label="状态：空闲" className="flex h-[18px] w-full items-center justify-center text-body-s leading-none opacity-60">💤</span>}
          {p.unread && status === 'Idle' && !s.stopping && <span role="status" title="Unread — 有新回复未查看" aria-label="状态：未读" className="flex h-[18px] w-full items-center justify-center text-body-s leading-none">📬</span>}
        </span>

        <div className="min-w-0 flex-1">
          {/* line 1 — title */}
          <div className="flex h-[18px] items-center gap-1.5">
            {renaming ? (
              <input
                autoFocus
                aria-label="Edit session title"
                value={renameValue}
                maxLength={200}
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
              <TypewriterText text={label} className={`min-w-0 flex-1 truncate text-body-s leading-[18px] ${p.active || status !== 'Idle' ? 'text-text-strong' : 'text-text'}`} />
            )}
            <span className={`shrink-0 font-mono text-2xs leading-none text-muted-strong ${menuOpen ? 'invisible' : ''}`}>{relTime(s.updated)}</span>
            <button
              type="button"
              aria-label="Session menu"
              onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
              onClick={() => setMenuOpen(v => !v)}
              className={`grid h-5 w-5 shrink-0 place-items-center rounded text-body-s leading-none text-muted transition-opacity hover:bg-bg-elevated hover:text-text-strong ${menuOpen ? 'bg-bg-elevated text-text-strong opacity-100' : 'opacity-50 group-hover:opacity-100 md:opacity-0'}`}
            >⋯</button>
          </div>

          {/* line 2 — meta; fixed height keeps the list from jittering */}
          <div className="flex h-[16px] items-center gap-1 overflow-hidden">
            {s.pinned && <span title="Pinned" className="shrink-0 text-2xs leading-none text-accent">📌</span>}
            {chips.map(t => <TagChip key={t} tag={t} active={p.tagFilter === t} onClick={p.onToggleTagFilter} />)}
            {extra > 0 && <span className="shrink-0 rounded-full bg-bg-hover px-1 text-2xs font-semibold leading-[14px] text-muted-strong" title={tags.join(', ')}>+{extra}</span>}
            {status === 'Needs Input' && <span className="shrink-0 text-2xs leading-none font-semibold text-warn">等待输入</span>}
            {p.showProject && proj && <span className="min-w-0 truncate font-mono text-2xs leading-none text-muted-strong" title={s.cwd || ''}>{proj}</span>}
            {p.showProject && s.workspace && s.workspace !== 'default' && (
              <span className="ml-auto shrink-0 truncate text-2xs leading-none font-semibold text-ok" title={`workspace: ${s.workspace}`}>{s.workspace}</span>
            )}
          </div>
        </div>
      </div>

      {tagEditing && (
        <TagEditor tags={s.tags} allTags={p.allTags} onTags={p.onTags} onClose={() => setTagEditing(false)} />
      )}

      {menuOpen && <RowMenu items={menuItems} up={p.up} ariaLabel={`Session actions for ${label}`} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

// ─────────────────────────── sidebar ───────────────────────────

interface ChatSidebarProps {
  slots: Slot[]
  activeSlot: string | null
  unreadSlots: string[]
  onNewSessionInCwd?: (cwd: string) => void
  onNewSession?: () => void
  mobileOpen?: boolean
  onMobileClose?: () => void
}

function ChatSidebar({
  slots, activeSlot, unreadSlots,
  onNewSessionInCwd, onNewSession,
  mobileOpen, onMobileClose,
}: ChatSidebarProps) {
  const dispatch = useAppDispatch()

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_LS_KEY)
    const n = saved ? parseInt(saved, 10) : NaN
    return !isNaN(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : 260
  })
  const [slotFilter, setSlotFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [slotsGroupMode, setSlotsGroupMode] = useState<GroupMode>(() => (localStorage.getItem(SLOTS_GROUP_LS_KEY) as GroupMode) || 'date')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try { const s = localStorage.getItem(COLLAPSED_GROUPS_LS_KEY); return s ? new Set(JSON.parse(s)) : new Set() } catch { return new Set() }
  })

  const sidebarDragging = useRef(false)
  const sidebarStartX = useRef(0)
  const sidebarStartW = useRef(0)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDragging.current) return
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarStartW.current + e.clientX - sidebarStartX.current)))
    }
    const onUp = () => {
      if (!sidebarDragging.current) return
      sidebarDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setSidebarWidth(w => { localStorage.setItem(SIDEBAR_LS_KEY, String(w)); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      localStorage.setItem(COLLAPSED_GROUPS_LS_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const counts = tagCounts(slots)
  const allTagNames = counts.map(c => c.tag)
  const q = slotFilter.trim().toLowerCase()
  const filtered = slots.filter(s =>
    (!tagFilter || visibleTags(s.tags).includes(tagFilter)) &&
    (!q || [s.title, s.key, s.agent || '', s.workspace || '', projectName(s.cwd), visibleTags(s.tags).join(' ')].join(' ').toLowerCase().includes(q))
  )
  const groups = buildGroups(filtered, slotsGroupMode)
  const needsHeaders = groups.length > 1 || (groups.length === 1 && groups[0].key !== '')

  const setPinned = (key: string, pinned: boolean) => {
    dispatch(sseSlotPinned({ key, pinned }))
    api.pinSlot(key, pinned).catch(() => dispatch(fetchSlots()))
  }

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onMobileClose} />}
      <div className={`pidash-sidebar bg-bg-accent border-r border-border flex-col shrink-0 relative
        fixed top-0 left-0 bottom-0 w-[280px] z-50 transition-transform duration-300
        pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]
        md:relative md:z-auto md:translate-x-0 md:transition-none md:flex md:pt-0 md:pb-0
        ${mobileOpen ? 'flex translate-x-0' : 'hidden md:flex -translate-x-full md:translate-x-0'}`}
        style={{ width: typeof window !== 'undefined' && window.innerWidth >= 768 ? sidebarWidth : undefined }}>
        {/* drag handle (desktop only) */}
        <div
          className="absolute top-0 -right-[2px] z-10 hidden h-full w-[5px] cursor-col-resize items-center justify-center group/drag md:flex"
          onMouseDown={e => { e.preventDefault(); sidebarDragging.current = true; sidebarStartX.current = e.clientX; sidebarStartW.current = sidebarWidth; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none' }}
        >
          <div className="h-full w-[2px] bg-transparent transition-colors duration-200 group-hover/drag:bg-accent group-active/drag:bg-accent-hover" />
        </div>

        {/* header */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <span className="flex min-w-0 items-center gap-1.5 text-meta font-medium uppercase tracking-[.05em] text-muted">
            Sessions <InfoTip text="Each tab is an independent pi session. Hover a row for ⋯ actions: rename, tags, pin and close. Click a tag to filter." />
            <span className="shrink-0 font-mono text-2xs normal-case tracking-normal text-muted-strong">
              {tagFilter || q ? `${filtered.length}/${slots.length}` : slots.length}
            </span>
          </span>
          <button
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-accent text-lg text-accent-fg transition hover:rotate-90 hover:scale-110 hover:bg-accent-hover hover:shadow-[0_0_16px_var(--accent-glow)] active:scale-95"
            onClick={() => onNewSession ? onNewSession() : dispatch(switchSlot(null))}
            title="New chat" aria-label="New chat session">+</button>
        </div>

        {/* filter + group mode + tag rail */}
        <div className="px-2 pt-2 pb-1">
          <SearchInput placeholder="Filter sessions…" value={slotFilter} onChange={e => setSlotFilter(e.target.value)} />
        </div>
        <div className="mx-2 mb-1 flex gap-0.5 rounded-md border border-border bg-bg p-0.5">
          {(['date', 'project', 'tag', 'status'] as GroupMode[]).map(m => (
            <button key={m} type="button" onClick={() => { setSlotsGroupMode(m); localStorage.setItem(SLOTS_GROUP_LS_KEY, m) }}
              className={`flex-1 rounded py-[3px] text-2xs capitalize transition-colors ${slotsGroupMode === m ? 'bg-bg-hover font-semibold text-text-strong shadow-[inset_0_0_0_1px_var(--border-strong)]' : 'text-muted hover:text-text'}`}>{m}</button>
          ))}
        </div>
        {counts.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto px-2 pb-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" onClick={() => setTagFilter(null)}
              className={`shrink-0 rounded-full border px-2 py-px text-2xs font-semibold leading-[16px] ${!tagFilter ? 'border-border-strong bg-bg-hover text-text-strong' : 'border-transparent text-muted hover:text-text'}`}>
              全部
            </button>
            {counts.slice(0, 12).map(({ tag, count }) => (
              <TagChip key={tag} tag={tag} active={tagFilter === tag} onClick={t => setTagFilter(f => f === t ? null : t)} title={`#${tag} · ${count} 个会话`} />
            ))}
          </div>
        )}

        {/* list */}
        <div className="flex-1 overflow-y-auto px-1 pb-2">
          {groups.map(g => {
            const gk = g.key || '__ungrouped'
            const collapsed = collapsedGroups.has(gk)
            const isPinned = g.key === PINNED_GROUP
            return (
              <div key={gk}>
                {needsHeaders && (
                  <div
                    className={`sticky top-0 z-10 flex cursor-pointer select-none items-center gap-1.5 px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[.06em] transition-colors hover:text-text ${isPinned ? 'text-accent' : 'text-muted-strong'}`}
                    style={{ background: 'linear-gradient(var(--bg-accent) 72%, transparent)' }}
                    onClick={() => toggleGroup(gk)}
                  >
                    <span className={`text-2xs transition-transform ${collapsed ? '' : 'rotate-90'}`}>▶</span>
                    {g.key || 'Other'}
                    <span className="ml-auto font-mono text-2xs font-normal opacity-60">{g.items.length}</span>
                  </div>
                )}
                {!collapsed && g.items.map((s, i) => (
                  <SlotRow
                    key={s.key}
                    slot={s}
                    active={activeSlot === s.key}
                    unread={unreadSlots.includes(s.key)}
                    showProject={slotsGroupMode !== 'project'}
                    tagFilter={tagFilter}
                    up={i >= g.items.length - 2}
                    allTags={allTagNames}
                    onActivate={() => { if (activeSlot !== s.key) dispatch(switchSlot(s.key)); onMobileClose?.() }}
                    onToggleTagFilter={t => setTagFilter(f => f === t ? null : t)}
                    onPin={pinned => setPinned(s.key, pinned)}
                    onNewInDir={() => { if (s.cwd) onNewSessionInCwd?.(s.cwd) }}
                    onClose={() => dispatch(deleteSlot(s.key))}
                    onRename={title => { dispatch(sseSlotTitle({ key: s.key, title })); api.renameSlot(s.key, title).catch(() => {}) }}
                    onTags={tags => api.tagSlot(s.key, tags).catch(() => {})}
                  />
                ))}
              </div>
            )
          })}
          {!filtered.length && (
            <div className="px-3 py-6 text-center text-meta text-muted-strong">{slots.length ? '没有匹配的会话' : '还没有会话'}</div>
          )}
        </div>
      </div>
    </>
  )
}

export default memo(ChatSidebar)
