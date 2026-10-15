/**
 * Goal anchor parsing and progress maths.
 *
 * The `pi-tsien-goal` extension persists its state as session entries
 * (`customType: 'goal-state'`). Both the dashboard frontend (task-anchor dialog)
 * and backend (session-list badge) need to read that state, so the parsing and
 * the derived counts live here instead of in one of the two consumers.
 *
 * Pure data: no I/O, no React, no Node APIs.
 */

export type GoalStatus = 'active' | 'paused' | 'complete'
export type GoalWorkItemState = 'todo' | 'in_progress' | 'done' | 'blocked' | 'deferred'

export interface GoalBlocker {
  title: string
  reason?: string
  kind?: string
  disposition?: string
  owner?: string
  proposedResolution?: string
}

export interface GoalWorkItem {
  id: string
  title: string
  state?: GoalWorkItemState
  description?: string
  dependsOn: string[]
}

export interface GoalSourceDoc {
  path?: string
  kind?: string
  brief?: string
}

export interface GoalAnchor {
  objective: string
  status?: GoalStatus
  progress: { current?: string; lastSummary?: string }
  blockers: GoalBlocker[]
  acceptanceCriteria: string[]
  constraints: string[]
  workItems: GoalWorkItem[]
  sourceDocs: GoalSourceDoc[]
  /** Timestamp of the newest `goal-state` entry, when the session recorded one. */
  updatedAt?: number
  /** `type: 'message'` entries recorded after that newest `goal-state` entry. */
  messagesSinceUpdate: number
}

/** Derived counts a session row or dialog can show without re-reading entries. */
export interface GoalProgress {
  done: number
  total: number
  /** Open blockers whose disposition is `needs_user`. */
  needsUser: number
  status?: GoalStatus
  /** True when the checklist is probably out of date; see `goalStaleness`. */
  stale: boolean
}

export type GoalStalenessReason = 'complete_with_open_items' | 'no_recent_update'

/**
 * A goal is "complete" as soon as a single work item is ticked off; the checklist
 * keeps its last value. Wording it as a hint rather than an error is deliberate —
 * the dashboard cannot know whether the agent forgot or the item was skipped.
 *
 * The threshold is measured against real sessions on this machine: goals that sat
 * untouched ran 119–1790 message entries since their last update, so a low number
 * (the first draft used 15) would flag nearly every long session and teach the
 * reader to ignore the hint.
 */
export const GOAL_STALE_MESSAGE_THRESHOLD = 300

export function goalProgressOf(anchor: GoalAnchor | null | undefined): GoalProgress | null {
  if (!anchor) return null
  const total = anchor.workItems.length
  const done = anchor.workItems.filter(item => item.state === 'done').length
  const needsUser = anchor.blockers.filter(blocker => blocker.disposition === 'needs_user').length
  return {
    done,
    total,
    needsUser,
    ...(anchor.status ? { status: anchor.status } : {}),
    stale: goalStaleness(anchor) !== null,
  }
}

export function goalStaleness(anchor: GoalAnchor | null | undefined): GoalStalenessReason | null {
  if (!anchor) return null
  const total = anchor.workItems.length
  const done = anchor.workItems.filter(item => item.state === 'done').length
  if (anchor.status === 'complete' && total > 0 && done < total) return 'complete_with_open_items'
  if (total > 0 && done < total && anchor.messagesSinceUpdate >= GOAL_STALE_MESSAGE_THRESHOLD) return 'no_recent_update'
  return null
}

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((item): item is string => !!item) : []
}

function goalStatus(value: unknown): GoalStatus | undefined {
  return value === 'active' || value === 'paused' || value === 'complete' ? value : undefined
}

function workItemState(value: unknown): GoalWorkItemState | undefined {
  return value === 'todo' || value === 'in_progress' || value === 'done' || value === 'blocked' || value === 'deferred'
    ? value
    : undefined
}

function entryTimestamp(value: unknown): number | undefined {
  const entry = record(value)
  const raw = entry?.timestamp ?? entry?.time
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Read the newest persisted `pi-tsien-goal` state from a session snapshot.
 *
 * Returns `null` when the session never set a goal, so callers can tell
 * "no goal was ever created" apart from "goal set but nothing recorded yet".
 */
export function goalAnchorFromEntries(entries: readonly unknown[]): GoalAnchor | null {
  let foundState = false
  let latestState: unknown
  let latestIndex = -1

  entries.forEach((value, index) => {
    const entry = record(value)
    if (entry?.type !== 'custom' || entry.customType !== 'goal-state') return
    const payload = record(entry.data)
    if (!payload || !('state' in payload)) return
    latestState = payload.state
    latestIndex = index
    foundState = true
  })

  if (!foundState) return null
  const state = record(latestState)
  const objective = text(state?.objective)
  if (!state || !objective) return null

  const blockers: GoalBlocker[] = []
  const structuredBlockers = Array.isArray(state.blockers) ? state.blockers : []
  for (const value of structuredBlockers) {
    const blocker = record(value)
    const title = text(blocker?.title)
    // Only open blockers are actionable; resolved ones stay in the ledger.
    if (blocker?.state !== 'open' || !title) continue
    const reason = text(blocker.reason)
    const kind = text(blocker.kind)
    const disposition = text(blocker.disposition)
    const owner = text(blocker.owner)
    const proposedResolution = text(blocker.proposedResolution)
    blockers.push({
      title,
      ...(reason ? { reason } : {}),
      ...(kind ? { kind } : {}),
      ...(disposition ? { disposition } : {}),
      ...(owner ? { owner } : {}),
      ...(proposedResolution ? { proposedResolution } : {}),
    })
  }

  // Older goals recorded blockers only as free text under `progress.blocked`.
  const knownText = new Set(blockers.flatMap(blocker => [blocker.title, blocker.reason ?? ''])
    .map(value => value.toLocaleLowerCase()).filter(Boolean))
  const progress = record(state.progress)
  for (const title of textList(progress?.blocked)) {
    const normalized = title.toLocaleLowerCase()
    if (knownText.has(normalized)) continue
    knownText.add(normalized)
    blockers.push({ title })
  }

  const workItems = (Array.isArray(state.workItems) ? state.workItems : []).flatMap(value => {
    const item = record(value)
    const title = text(item?.title)
    if (!item || !title) return []
    const id = text(item.id) ?? title
    const state = workItemState(item.state)
    const description = text(item.description)
    return [{
      id,
      title,
      ...(state ? { state } : {}),
      ...(description ? { description } : {}),
      dependsOn: textList(item.dependsOn),
    }]
  })

  const sourceDocs = (Array.isArray(state.sourceDocs) ? state.sourceDocs : []).flatMap(value => {
    const source = record(value)
    const path = text(source?.path)
    const kind = text(source?.kind)
    const brief = text(source?.brief)
    if (!path && !brief) return []
    return [{ ...(path ? { path } : {}), ...(kind ? { kind } : {}), ...(brief ? { brief } : {}) }]
  })

  let messagesSinceUpdate = 0
  for (let index = latestIndex + 1; index < entries.length; index += 1) {
    if (record(entries[index])?.type === 'message') messagesSinceUpdate += 1
  }

  const status = goalStatus(state.status)
  const current = text(progress?.current)
  const lastSummary = text(progress?.lastSummary)
  const updatedAt = entryTimestamp(entries[latestIndex])
  return {
    objective,
    ...(status ? { status } : {}),
    progress: { ...(current ? { current } : {}), ...(lastSummary ? { lastSummary } : {}) },
    blockers,
    acceptanceCriteria: textList(state.acceptanceCriteria),
    constraints: textList(state.constraints),
    workItems,
    sourceDocs,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messagesSinceUpdate,
  }
}