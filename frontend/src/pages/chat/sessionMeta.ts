/**
 * Session-meta helpers for the sidebar: tag visibility/color, relative time,
 * project name and slot ordering. Pure functions — no React, no IO.
 */

/** A slot as seen by the sidebar (structural subset). */
export interface SlotMeta {
  key: string
  title: string
  running: boolean
  stopping?: boolean
  pending_approval?: boolean
  cwd?: string | null
  workspace?: string
  agent?: string
  tags?: string[]
  pinned?: boolean
  created?: string
  updated?: string
}

/**
 * System tags are machine-written (scheduled jobs) and must not clutter the
 * sidebar: hidden from chips, from the tag-filter rail and from tag grouping.
 * Convention: a `<namespace>:<id>` tag, plus the legacy bare `'job'` written
 * before the namespacing change.
 */
const SYSTEM_TAG_PATTERN = /^[a-z][a-z0-9-]*:/
export function isSystemTag(tag: string | undefined | null): boolean {
  if (!tag) return false
  const t = tag.toLowerCase()
  return t === 'job' || SYSTEM_TAG_PATTERN.test(t)
}

/** Tags worth showing to a human. */
export function visibleTags(tags?: string[] | null): string[] {
  return (tags || []).filter(t => !isSystemTag(t))
}

/**
 * Deterministic tag color from the tag text — no per-tag config, stable across
 * reloads, uses only theme tokens that read well in every theme.
 */
const TAG_PALETTE = [
  'bg-accent-subtle text-accent border-accent',
  'bg-ok-subtle text-ok border-ok',
  'bg-warn-subtle text-warn border-warn',
  'bg-danger-subtle text-danger border-danger',
  'bg-bg-hover text-text border-border-strong',
]
export function tagColorClass(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_PALETTE[h % TAG_PALETTE.length]
}

/** `'ai-dev/pi-dashboard'` → last segment; `''` when no cwd. */
export function projectName(cwd?: string | null): string {
  if (!cwd) return ''
  return cwd.replace(/\/+$/, '').split('/').pop() || ''
}

/** Compact relative time: 45s / 12m / 3h / 5d / 07-19 / 24-11-02. */
export function relTime(iso: string | number | undefined | null, now: number = Date.now()): string {
  if (iso === undefined || iso === null || iso === '') return ''
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  if (isNaN(t)) return ''
  const sec = Math.max(0, Math.round((now - t) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d`
  const d = new Date(t)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (d.getFullYear() === new Date(now).getFullYear()) return `${mm}-${dd}`
  return `${String(d.getFullYear()).slice(2)}-${mm}-${dd}`
}

/**
 * Sidebar ordering: pinned first (so the Pinned group always wins), then most
 * recently active. Missing timestamps sort last.
 */
export function slotOrder(a: SlotMeta, b: SlotMeta): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
  const ta = a.updated ? new Date(a.updated).getTime() : 0
  const tb = b.updated ? new Date(b.updated).getTime() : 0
  return tb - ta
}

/** tag → number of slots carrying it (system tags excluded). */
export function tagCounts(slots: SlotMeta[]): { tag: string; count: number }[] {
  const m = new Map<string, number>()
  for (const s of slots) {
    for (const t of visibleTags(s.tags)) m.set(t, (m.get(t) || 0) + 1)
  }
  return Array.from(m.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
