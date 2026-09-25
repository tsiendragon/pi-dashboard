import type { Completion, LaneDef, PlanningOverlay, TaskFact } from '@shared/tasks.js'

export const COMPLETION_LABEL: Record<Completion, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  paused: '暂停/阻塞',
}

export const COMPLETION_DOT: Record<Completion, string> = {
  todo: 'bg-muted',
  doing: 'bg-info',
  done: 'bg-ok',
  paused: 'bg-warn',
}

export const COMPLETION_CHIP: Record<Completion, string> = {
  todo: 'bg-bg-elevated text-muted border-border',
  doing: 'bg-bg-hover text-info border-info',
  done: 'bg-ok-subtle text-ok border-ok',
  paused: 'bg-warn-subtle text-warn border-warn',
}

export const KIND_LABEL: Record<string, string> = { epic: 'Epic', task: 'Task', todo: 'Todo', item: 'Item' }

/**
 * Epic status is visibility (active/archived), not completion — an active epic is
 * NOT "in progress". Tasks/items use the completion label.
 */
export function statusLabel(task: TaskFact): string {
  if (task.kind === 'epic') return task.archived ? '归档' : '活跃'
  return COMPLETION_LABEL[task.completion]
}

export function statusChipClass(task: TaskFact): string {
  if (task.kind === 'epic') {
    return task.archived ? 'bg-bg-elevated text-muted border-border' : 'bg-accent-subtle text-accent border-accent'
  }
  return COMPLETION_CHIP[task.completion]
}

export function laneOf(task: TaskFact, lanes: LaneDef[], planning: PlanningOverlay): string {
  const override = planning[task.uid]?.laneOverride
  if (override) return override
  for (const lane of lanes) {
    const m = lane.match
    if (m?.kind && m.kind.includes(task.kind)) return lane.id
    if (m?.tag && task.tags.includes(m.tag)) return lane.id
    if (m?.pathPrefix && task.path?.startsWith(m.pathPrefix)) return lane.id
  }
  return 'uncategorized'
}

export function isFocused(uid: string, planning: PlanningOverlay): boolean {
  const entry = planning[uid]
  return !!entry && (entry.pinned === true || entry.focusOrder != null)
}

export function sortTasks(a: TaskFact, b: TaskFact, planning: PlanningOverlay): number {
  const pa = planning[a.uid]
  const pb = planning[b.uid]
  const fa = pa?.focusOrder ?? Number.MAX_SAFE_INTEGER
  const fb = pb?.focusOrder ?? Number.MAX_SAFE_INTEGER
  if (fa !== fb) return fa - fb
  const pra = pa?.priority ?? 3
  const prb = pb?.priority ?? 3
  if (pra !== prb) return pra - prb
  const ca = a.completion === 'doing' ? 0 : 1
  const cb = b.completion === 'doing' ? 0 : 1
  if (ca !== cb) return ca - cb
  return (b.updatedAt || b.title).localeCompare(a.updatedAt || a.title)
}

export type StatusFilter = 'active' | 'all' | Completion | 'archived'

export function matchesStatus(task: TaskFact, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'archived') return task.archived
  if (filter === 'active') return !task.archived && task.completion !== 'done'
  return !task.archived && task.completion === filter
}

export function matchesSearch(task: TaskFact, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return task.title.toLowerCase().includes(needle) || task.id.toLowerCase().includes(needle)
}
