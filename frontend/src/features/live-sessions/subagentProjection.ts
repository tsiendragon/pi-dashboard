export type ProjectionStatus = 'active' | 'attention' | 'completed' | 'stopped' | 'unknown'
export type ProjectionSource = 'workbench' | 'live-session'
export type ProjectionRecord = Record<string, unknown>

const ACTIVE = new Set(['running', 'in_progress', 'active', 'queued', 'starting', 'pending', 'busy'])
const COMPLETED = new Set(['completed', 'succeeded', 'success', 'done', 'finished'])
const STOPPED = new Set(['cancelled', 'canceled', 'interrupted', 'stopped', 'terminated', 'exited'])
const ATTENTION = new Set(['failed', 'failure', 'error', 'blocked', 'stalled', 'waiting_approval', 'needs_approval', 'disconnected', 'lost'])

export function asProjectionRecord(value: unknown): ProjectionRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ProjectionRecord : {}
}

export function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function projectStatus(value: unknown): ProjectionStatus {
  const status = textValue(value).trim().toLowerCase()
  if (ACTIVE.has(status)) return 'active'
  if (ATTENTION.has(status)) return 'attention'
  if (COMPLETED.has(status)) return 'completed'
  if (STOPPED.has(status)) return 'stopped'
  return 'unknown'
}

export function recordTaskStatus(record: unknown): string {
  const item = asProjectionRecord(record)
  if (typeof item.activeRunId === 'string' && item.activeRunId) return 'running'
  if (item.needsAttention === true || item.stalled === true) return 'blocked'
  return textValue(item.latestRunStatus) || textValue(item.status)
}

export function stableTaskId(task: unknown, index = 0): string {
  const item = asProjectionRecord(task)
  for (const key of ['taskId', 'key', 'id', 'workId', 'sessionId']) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return `task-${index}`
}

export interface TaskCounts {
  total: number
  active: number
  completed: number
  failed: number
  attention: number
  skipped: number
  stopped: number
  unknown: number
  hasProgress: boolean
}

export function projectTaskCounts(tasks: unknown[]): TaskCounts {
  const counts: TaskCounts = { total: tasks.length, active: 0, completed: 0, failed: 0, attention: 0, skipped: 0, stopped: 0, unknown: 0, hasProgress: tasks.length > 0 }
  for (const task of tasks) {
    const item = asProjectionRecord(task)
    const status = projectStatus(item.status)
    if (status === 'active') counts.active += 1
    else if (status === 'completed') counts.completed += 1
    else if (status === 'attention') {
      if (textValue(item.status).toLowerCase() === 'skipped' || item.skipped === true) counts.skipped += 1
      else if (['failed', 'failure', 'error'].includes(textValue(item.status).toLowerCase())) counts.failed += 1
      else counts.attention += 1
    } else if (status === 'stopped') counts.stopped += 1
    else if (textValue(item.status).toLowerCase() === 'skipped' || item.skipped === true) counts.skipped += 1
    else counts.unknown += 1
  }
  return counts
}

export function recordList(value: unknown, key = 'items'): ProjectionRecord[] {
  const container = asProjectionRecord(value)
  const list = Array.isArray(container[key]) ? container[key] : []
  return list.map(asProjectionRecord)
}

export function workflowTaskList(workflow: unknown): ProjectionRecord[] {
  const item = asProjectionRecord(workflow)
  const stages = Array.isArray(item.stages) ? item.stages : []
  return stages.flatMap(stage => {
    const stageRecord = asProjectionRecord(stage)
    return Array.isArray(stageRecord.tasks) ? stageRecord.tasks.map(asProjectionRecord) : []
  })
}

export function isWorkflowChild(record: unknown): boolean {
  const item = asProjectionRecord(record)
  return ['workflowId', 'parentWorkflowId', 'workflowTaskId'].some(key => {
    const value = item[key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

export function explicitlyReportedModel(record: unknown): string | undefined {
  const item = asProjectionRecord(record)
  for (const key of ['model', 'actualModel', 'providerModel']) {
    if (typeof item[key] === 'string' && item[key].trim()) return item[key] as string
  }
  return undefined
}

export function explicitlyReportedUsage(record: unknown): ProjectionRecord | undefined {
  const item = asProjectionRecord(record)
  return item.usage && typeof item.usage === 'object' && !Array.isArray(item.usage) ? item.usage as ProjectionRecord : undefined
}

export function isCollapsedByDefault(status: unknown): boolean {
  const projected = projectStatus(status)
  return projected === 'completed' || projected === 'stopped'
}

export function projectSubagentSnapshot(value: unknown, source: ProjectionSource) {
  const snapshot = asProjectionRecord(value)
  const conversations = recordList(snapshot.conversations).map((item): ProjectionRecord => ({ ...item, status: recordTaskStatus(item) }))
  const workflows = recordList(snapshot.workflows)
  return {
    source,
    conversations,
    workflows,
    topLevelConversations: conversations.filter(item => !isWorkflowChild(item)),
  }
}
