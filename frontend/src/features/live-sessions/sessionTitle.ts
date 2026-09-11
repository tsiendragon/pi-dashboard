import type { LiveSessionDetail, LiveSessionSummary } from '@shared/live-sessions'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function clipTitle(value: string): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const firstSentence = cleaned.split(/[\n。！？.!?]/, 1)[0]?.trim() || cleaned
  return Array.from(firstSentence).slice(0, 10).join('')
}

function messageEntries(detail: LiveSessionDetail | undefined): Record<string, unknown>[] {
  if (!detail) return []
  return detail.entries.map(record).filter((entry): entry is Record<string, unknown> => !!entry)
}

function messageOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type === 'message' && record(entry.message)) return record(entry.message)
  if ((entry.type === 'message_end' || entry.type === 'message_update') && record(entry.data)) {
    return record((entry.data as Record<string, unknown>).message)
  }
  return undefined
}

/** Normalize an explicit session name (agent `set_session_title` or web
 *  rename). Both are already capped at 80 chars upstream; only strip breaks. */
function cleanName(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Fallback title from the workspace: git branch first, then directory name. */
function workspaceTitle(session: LiveSessionSummary): string {
  if (session.git?.branch) return session.git.branch
  const cwd = (session.canonicalCwd || session.cwd || '').replace(/\/+$/, '')
  return cwd.split('/').pop() || cwd || ''
}

function parentToolTitle(parent: LiveSessionDetail | undefined, toolCallId?: string): string {
  if (!parent || !toolCallId) return ''
  for (const entry of messageEntries(parent)) {
    const message = messageOf(entry)
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const toolCall = record(part)
      if (!toolCall || toolCall.type !== 'toolCall' || toolCall.id !== toolCallId) continue
      const args = record(toolCall.arguments)
      if (!args) return clipTitle(typeof toolCall.name === 'string' ? toolCall.name : '子 Agent')
      for (const key of ['label', 'title', 'task', 'prompt', 'description']) {
        const value = typeof args[key] === 'string' ? clipTitle(args[key] as string) : ''
        if (value) return value
      }
      return clipTitle(typeof toolCall.name === 'string' ? toolCall.name : '子 Agent')
    }
  }
  return ''
}

export type SubagentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'killed' | 'cancelled' | 'unknown'

function normalizeTaskStatus(value: unknown): SubagentTaskStatus | undefined {
  if (value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'killed' || value === 'cancelled') return value
  return undefined
}

export function buildSubagentStatuses(details: Record<string, LiveSessionDetail>): Record<string, SubagentTaskStatus> {
  const statuses: Record<string, SubagentTaskStatus> = {}
  const set = (workId: unknown, status: unknown) => {
    if (typeof workId !== 'string') return
    const normalized = normalizeTaskStatus(status)
    if (normalized) statuses[workId] = normalized
  }
  for (const detail of Object.values(details)) {
    for (const entry of messageEntries(detail)) {
      const message = messageOf(entry)
      if (!message || typeof message.toolName !== 'string' || !message.toolName.startsWith('subagent_')) continue
      const toolDetails = record(message.details)
      if (!toolDetails) continue
      set(toolDetails.workId, toolDetails.status)
      if (message.toolName === 'subagent_start') set(toolDetails.workId, 'queued')
      if (Array.isArray(toolDetails.completed)) for (const item of toolDetails.completed) {
        const result = record(item)
        set(result?.workId, result?.status || 'completed')
      }
      if (Array.isArray(toolDetails.pending)) for (const item of toolDetails.pending) {
        const result = record(item)
        set(result?.workId, result?.status || 'running')
      }
    }
  }
  return statuses
}

export function buildSessionTitles(
  sessions: Record<string, LiveSessionSummary>,
  details: Record<string, LiveSessionDetail>,
): Record<string, string> {
  const bySessionId = new Map<string, LiveSessionDetail>()
  for (const detail of Object.values(details)) bySessionId.set(detail.summary.sessionId, detail)
  const titles: Record<string, string> = {}
  for (const session of Object.values(sessions)) {
    const explicit = cleanName(session.sessionName || '')
    const parent = session.parentSessionId ? bySessionId.get(session.parentSessionId) : undefined
    const title = explicit || parentToolTitle(parent, session.parentToolCallId) || workspaceTitle(session) || (session.role === 'subagent' ? '子 Agent' : '等待输入')
    if (title) titles[session.processInstanceId] = title
  }
  return titles
}
