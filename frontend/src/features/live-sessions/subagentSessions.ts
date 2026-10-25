import type { LiveSessionSummary } from '@shared/live-sessions'
import {
  asProjectionRecord, projectStatus, recordList, textValue, workflowTaskList,
  type ProjectionRecord, type ProjectionStatus,
} from './subagentProjection'

export interface SubagentSessionItem {
  id: string
  label: string
  status: string
  bucket: ProjectionStatus
  session?: LiveSessionSummary
  record?: ProjectionRecord
}

/** A transport connection is not a task result. Match only explicit task/session identifiers. */
export function projectSubagentSessions(
  sessions: readonly LiveSessionSummary[],
  feature: unknown,
  taskStatuses: Record<string, string> = {},
): SubagentSessionItem[] {
  const snapshot = asProjectionRecord(feature)
  const jobs = recordList(snapshot.jobs)
  const conversations = recordList(snapshot.conversations)
  const agents = recordList(snapshot.agents)
  const workflows = recordList(snapshot.workflows)
  const workflowTasks = workflows.flatMap(workflowTaskList)
  const workflowSessions = new Set(workflowTasks.map(task => textValue(task.sessionId)).filter(Boolean))
  const workflowWorkIds = new Set(workflows.flatMap(workflow => [textValue(workflow.workId),
    textValue(workflow.id).startsWith('workflow_') ? textValue(workflow.id).slice('workflow_'.length) : '']).filter(Boolean))
  const workflowIds = workflows.map(workflow => textValue(workflow.id)).filter(Boolean)
  const isWorkflow = (item: ProjectionRecord) => !!textValue(item.workflowId)
    || !!textValue(item.parentWorkflowId) || workflowSessions.has(textValue(item.sessionId) || textValue(item.id))
  const records = [...conversations, ...agents].filter(item => !isWorkflow(item))
  const workflowTaskIds = new Set(workflowTasks.map(task => textValue(task.id)).filter(Boolean))
  const remaining = new Set(sessions.filter(session => !workflowTaskIds.has(session.subagentTaskId || '') && !workflowSessions.has(session.sessionId)
    && !workflowWorkIds.has(session.subagentWorkId || '')
    && !workflowIds.some(id => session.subagentWorkId === id || session.subagentWorkId?.startsWith(`${id}:`))))
  const result: SubagentSessionItem[] = []
  const seen = new Set<string>()
  for (const item of records) {
    const recordId = textValue(item.id) || textValue(item.sessionId) || textValue(item.workId)
    if (!recordId) continue
    const job = jobs.find(candidate => candidate.kind !== 'workflow'
      && (candidate.sessionId === recordId || (!!textValue(item.workId) && candidate.workId === item.workId)))
    const workId = textValue(item.workId) || textValue(job?.workId) || recordId
    const live = [...remaining].find(session => session.sessionId === recordId
      || session.subagentWorkId === workId)
    const id = workId || recordId
    if (seen.has(id)) continue
    seen.add(id)
    if (live) remaining.delete(live)
    const status = textValue(item.activeRunId) ? 'running'
      : item.needsAttention === true || item.stalled === true ? 'blocked'
        : textValue(item.latestRunStatus) || textValue(job?.status) || taskStatuses[workId] || textValue(item.status)
    /**
     * A launch leaves `queued`/`running` behind forever when the caller never asks for
     * the result (no `subagent_results`), so a finished agent kept reading as 运行中 —
     * and those rows have no stop and no collapse button, which is exactly how they piled
     * up on the strip. A live process or an explicit active run is the only proof of work
     * in progress; without either the row is history and belongs in a folded group.
     */
    const projected = projectStatus(status)
    const orphanedActive = projected === 'active' && !live && !textValue(item.activeRunId)
    result.push({ id, label: textValue(item.label) || textValue(item.task) || '子助手',
      status, bucket: orphanedActive ? 'stopped' : projected, session: live, record: item })
  }
  for (const session of remaining) {
    const id = session.subagentWorkId || session.sessionId
    if (seen.has(id)) continue
    seen.add(id)
    const status = taskStatuses[session.subagentWorkId || ''] || (session.status === 'running' ? 'running' : 'unknown')
    result.push({ id, label: session.sessionName || '子助手', status, bucket: projectStatus(status), session })
  }
  return result
}

export function isFailedSubagent(status: string): boolean {
  return ['failed', 'failure', 'error'].includes(status.trim().toLowerCase())
}

export function subagentGroups(items: readonly SubagentSessionItem[]) {
  return {
    active: items.filter(item => item.bucket === 'active'),
    attention: items.filter(item => item.bucket === 'attention' || item.bucket === 'unknown'),
    completed: items.filter(item => item.bucket === 'completed'),
    stopped: items.filter(item => item.bucket === 'stopped'),
  }
}
