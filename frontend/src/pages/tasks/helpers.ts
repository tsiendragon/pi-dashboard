import type { Completion, JiraCategory, LaneDef, PlanningOverlay, TaskFact } from '@shared/tasks.js'

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

/** Jira status → the three colours the list uses; `unknown` stays neutral. */
export const JIRA_DOT: Record<JiraCategory, string> = {
  todo: 'bg-muted',
  inprogress: 'bg-info',
  done: 'bg-ok',
  unknown: 'bg-border-strong',
}

/**
 * Local completion vs Jira's own category.
 *
 * Both directions matter: a task closed in the journal while the ticket is still open, and (the case
 * that actually bit us) a ticket already Done while the journal still says in_progress.
 */
export type JiraDrift = 'jira_ahead' | 'local_ahead'

export function jiraDrift(task: TaskFact): JiraDrift | undefined {
  const category = task.jiraStatus?.category
  // Epics are visibility-tracked (active/archived), so comparing their completion would be noise.
  if (!category || category === 'unknown' || task.kind === 'epic') return undefined
  const localDone = task.completion === 'done'
  if (localDone && category !== 'done') return 'local_ahead'
  if (!localDone && category === 'done') return 'jira_ahead'
  return undefined
}

export const JIRA_DRIFT_LABEL: Record<JiraDrift, string> = {
  jira_ahead: 'Jira 已完成，本地未关',
  local_ahead: '本地已完成，Jira 未关',
}

/** "2 小时前" — date-only values are treated as local midnight, so ordering stays sane. */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return ''
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value
  const time = Date.parse(raw)
  if (Number.isNaN(time)) return ''
  const diff = now - time
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

/** Stage progress shown next to the stage's own name: `2/4`, empty when unknown. */
export function stageLabel(task: TaskFact): string {
  return task.stage ? `${task.stage.done}/${task.stage.total}` : ''
}
