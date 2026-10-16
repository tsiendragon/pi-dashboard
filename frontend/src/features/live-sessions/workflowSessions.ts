import type { LiveSessionSummary } from '@shared/live-sessions'
import { asProjectionRecord, textValue, workflowTaskList } from './subagentProjection'

/** Prefer explicit trace task identity; controller session IDs need not be Pi IDs. */
export function workflowTaskSession(task: unknown, sessions: readonly LiveSessionSummary[]): LiveSessionSummary | undefined {
  const record = asProjectionRecord(task)
  const taskId = textValue(record.id)
  const sessionId = textValue(record.sessionId)
  return sessions.find(session => (!!taskId && session.subagentTaskId === taskId)
    || (!!sessionId && session.sessionId === sessionId))
}

export function linkedWorkflowSessions(workflow: unknown, sessions: readonly LiveSessionSummary[]): LiveSessionSummary[] {
  const record = asProjectionRecord(workflow)
  const workflowId = textValue(record.id)
  const workId = textValue(record.workId) || (workflowId.startsWith('workflow_') ? workflowId.slice('workflow_'.length) : '')
  const tasks = workflowTaskList(record)
  const taskIds = new Set(tasks.map(task => textValue(task.id)).filter(Boolean))
  const sessionIds = new Set(tasks.map(task => textValue(task.sessionId)).filter(Boolean))
  return sessions.filter(session => taskIds.has(session.subagentTaskId || '') || sessionIds.has(session.sessionId)
    || (!!workId && session.subagentWorkId === workId))
}
