import type { LiveSessionGroup, LiveSessionMeta, LiveSessionSummary } from '@shared/live-sessions'

/** Heading of the pinned block in the Live Pi sidebar. */
export const PINNED_SECTION = '置顶'

/** Sub-agent rows are summarised elsewhere, never listed as top-level rows. */
export function isSubagent(session: LiveSessionSummary): boolean {
  return session.role === 'subagent' || !!session.parentSessionId
}

/** The task group a session belongs to, or undefined when it is ungrouped. */
export function groupOfSession(
  session: LiveSessionSummary,
  groups: readonly LiveSessionGroup[],
): LiveSessionGroup | undefined {
  return groups.find(group => group.sessionIds.includes(session.sessionId))
}

/** One block of the sidebar: the pinned block, a task group, or 未分组. */
export interface SessionSection {
  id: string
  name: string
  group?: LiveSessionGroup
  pinnedSection?: boolean
  sessions: LiveSessionSummary[]
}

/**
 * Lay sessions out into the sidebar's blocks and their within-block order.
 *
 * Shared by the sidebar and by fork placement, so a newly forked row is put
 * beside its source using exactly the order the reader sees. Block order is
 * fixed: 置顶 → task groups (creation order) → 未分组.
 */
export function buildSessionSections(
  sessions: readonly LiveSessionSummary[],
  meta: Record<string, LiveSessionMeta>,
  groups: readonly LiveSessionGroup[],
  order: string[],
): SessionSection[] {
  const main = sessions.filter(session => !isSubagent(session))
  const pinned = main.filter(session => meta[session.sessionId]?.pinned)
  const pinnedIds = new Set(pinned.map(session => session.processInstanceId))
  const rest = main.filter(session => !pinnedIds.has(session.processInstanceId))
  const out: SessionSection[] = []
  if (pinned.length) out.push({ id: '__pinned', name: PINNED_SECTION, pinnedSection: true, sessions: sortSessions(pinned, order) })
  for (const group of groups) {
    out.push({ id: group.id, name: group.name, group, sessions: sortSessions(rest.filter(session => group.sessionIds.includes(session.sessionId)), order) })
  }
  out.push({ id: '__ungrouped', name: '未分组', sessions: sortSessions(rest.filter(session => !groupOfSession(session, groups)), order) })
  return out.filter(section => section.sessions.length > 0)
}

/**
 * Ordering rules for the Live Pi Sessions sidebar.
 *
 * The order is *manual*: a row only moves when the user drags it (or uses the
 * `⋯` menu). Position is keyed by pi `sessionId` so it survives a Pi restart.
 * Sessions missing from the order list — new ones, and every session the user
 * never moved — are appended at the end of their block in `startedAt` order,
 * which is exactly the old behaviour, so nobody sees a jump on first load.
 */

/** Drop position inside one block: `index` is a slot in that block's anchor list. */
export interface DropTarget {
  sectionId: string
  index: number
}

export function buildOrderIndex(order: string[]): Map<string, number> {
  const index = new Map<string, number>()
  order.forEach((id, position) => { if (!index.has(id)) index.set(id, position) })
  return index
}

/**
 * Manual order first; unlisted sessions keep the legacy `startedAt` ascending
 * fallback (oldest first) and land at the block tail. The last tie-break keeps
 * the order deterministic across renders.
 */
export function sessionOrderIndex(order: string[]): (left: LiveSessionSummary, right: LiveSessionSummary) => number {
  const index = buildOrderIndex(order)
  const position = (session: LiveSessionSummary): number => index.get(session.sessionId) ?? Number.MAX_SAFE_INTEGER
  return (left, right) =>
    position(left) - position(right)
    || left.startedAt - right.startedAt
    || left.processInstanceId.localeCompare(right.processInstanceId)
}

/** Sort one block's rows: manual positions first, then new sessions at the tail. */
export function sortSessions(items: LiveSessionSummary[], order: string[]): LiveSessionSummary[] {
  return [...items].sort(sessionOrderIndex(order))
}

/**
 * Merge the stored order with what is on screen right now.
 *
 * `moveInOrder` anchors a drop against a row id, so the anchor has to exist in
 * the list. A user who never dragged anything has an empty stored order, and
 * moving one row of three must not disturb the other two — materializing the
 * current display order first (manual positions, then `startedAt`) makes every
 * drop anchor-able while leaving unranked rows exactly where they already are.
 */
export function materializeOrder(order: string[], displayed: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...displayed, ...order]) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Index of `sessionId` inside a block's anchor list, or -1 when absent. */
export function anchorIndexOf(anchors: string[], sessionId: string): number {
  return anchors.indexOf(sessionId)
}

/**
 * Move `sessionId` to `target.index` inside `target`'s block.
 *
 * `anchors` is the target block's rows **excluding** the dragged session, so the
 * insertion index means the same thing whether the user dropped inside the
 * block or moved the session in from another block. Only the moved id changes
 * position; every other id keeps its slot, so untouched rows never shift.
 *
 * A row from another block is only ordered relative to its new block: dropping
 * into a block with no anchors simply appends to the list (its display position
 * is decided by the block order, not by the flat list).
 */
export function moveInOrder(order: string[], sessionId: string, anchors: string[], index: number): string[] {
  if (!sessionId) return order
  const base = order.filter(id => id !== sessionId)
  const at = Math.max(0, Math.min(index, anchors.length))
  const next = anchors[at]
  const previous = at > 0 ? anchors[at - 1] : undefined
  if (next) {
    const nextIndex = base.indexOf(next)
    if (nextIndex >= 0) return [...base.slice(0, nextIndex), sessionId, ...base.slice(nextIndex)]
  }
  if (previous) {
    const previousIndex = base.indexOf(previous)
    if (previousIndex >= 0) return [...base.slice(0, previousIndex + 1), sessionId, ...base.slice(previousIndex + 1)]
  }
  return [...base, sessionId]
}

/**
 * Resolve the drop position from the DOM under the pointer.
 *
 * Rows and blocks carry `data-live-row` / `data-live-block`; a hit in the top
 * half of a row inserts before it, the bottom half after it, and a hit on the
 * block itself (header, padding, empty tail) appends to that block.
 * `anchorsOf` must return the block's rows **excluding the dragged session**,
 * matching `moveInOrder`'s insertion index.
 * Geometry lives here rather than in the component so it can be unit tested
 * without a real layout engine.
 */
export function resolveDropTarget(
  element: Element | null,
  rectOf: (element: Element) => { top: number; height: number },
  clientY: number,
  anchorsOf: (sectionId: string) => string[],
): DropTarget | undefined {
  const row = element?.closest?.('[data-live-row]')
  if (row) {
    const sectionId = row.getAttribute('data-live-block')
    const rowId = row.getAttribute('data-live-row')
    if (!sectionId || !rowId) return undefined
    const anchors = anchorsOf(sectionId)
    const rowIndex = anchors.indexOf(rowId)
    if (rowIndex < 0) return undefined
    const rect = rectOf(row)
    const after = clientY > rect.top + rect.height / 2
    return { sectionId, index: rowIndex + (after ? 1 : 0) }
  }
  const block = element?.closest?.('[data-live-block]')
  const sectionId = block?.getAttribute('data-live-block')
  if (!sectionId) return undefined
  return { sectionId, index: anchorsOf(sectionId).length }
}