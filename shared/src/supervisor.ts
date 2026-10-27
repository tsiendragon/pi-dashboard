import type { Completion, TaskKind, TasksResponse } from './tasks.js'
import type { LiveSessionSummary } from './live-sessions.js'

export type SupervisorMode = 'observe' | 'coordinate'
export type SupervisorOperation = 'context' | 'events' | 'query' | 'record' | 'correct' | 'task_create' | 'task_update' | 'working_state' | 'action' | 'report' | 'analyze' | 'inspect' | 'coordinate' | 'attachment_put'
export interface SupervisorConfig {
  enabled: boolean
  /** Display name used by the UI and injected into the main session's system prompt. */
  name?: string
  cwd: string
  pollIntervalMs: number
  staleAfterMs: number
  allowedObjects: string[]
  allowedSessionIds: string[]
  allowedRoots: string[]
  /** Accepted event categories. Replaces the standard vocabulary when set; normalization always fills it. */
  eventTypes?: string[]
  agentResources: { rolePath: string; skillPaths: string[]; extensionPaths: string[]; allowedTools: string[]; mode: SupervisorMode; /** Adds the read-only helper agents (workbench extension plus subagent tools). */ subagents?: boolean }
}
/** Default event vocabulary; keep the main Agent Skill in sync when changing it. */
export const SUPERVISOR_STANDARD_EVENT_TYPES = ['progress', 'reply', 'blocked', 'resumed', 'decision', 'result']
/** Written by dedicated operations; always accepted regardless of the configured vocabulary. */
export const SUPERVISOR_SYSTEM_EVENT_TYPES = ['working_state', 'suggestion']
export interface SupervisorSource { kind: 'user' | 'relay' | 'agent'; sessionId?: string; messageRef?: string }
export interface SupervisorEvent {
  id: string; objectRef: string; objectSnapshot?: { title: string; kind: TaskKind; parentUid?: string; ancestorUids?: string[] }; title: string; type: string; description: string
  occurredAt: string | null; recordedAt: string; recorder?: string; participants: string[]; source: SupervisorSource
  originalReply?: string; nextStep?: string; stage?: string; waitingFor?: string; attachmentIds: string[]
  version: number; requestId: string; payloadHash: string
  revisions: Array<{ version: number; at: string; actor: string; previous: Record<string, unknown> }>
  interval?: { kind: 'wait' | 'stage' | 'effort'; startEventId: string; durationMinutes?: number }
}
/** Listing projection: everything an agent needs to pick which event to open, without long text or revision history. */
export interface SupervisorEventSummary {
  id: string; objectRef: string; objectSnapshot?: { title: string; kind: TaskKind; parentUid?: string; ancestorUids?: string[] }; title: string; type: string
  occurredAt: string | null; recordedAt: string; recorder?: string; participants: string[]; source: SupervisorSource
  attachmentIds: string[]; version: number
  interval?: { kind: 'wait' | 'stage' | 'effort'; startEventId: string; durationMinutes?: number }
}
/** Constant-shaped result for the agent query operation and for the truncated context listing. */
export interface SupervisorEventList {
  events: SupervisorEventSummary[]; total: number; truncated: boolean; excludedWithoutTime: number
}
export interface SupervisorAttachment { id: string; name: string; mime: string; bytes: number; createdAt: string }
export interface SupervisorAction { id: string; objectRef?: string; title: string; reason: string; state: 'suggested' | 'open' | 'done' | 'dismissed'; sourceRefs: string[]; createdAt: string; updatedAt: string }
export interface SupervisorReport { id: string; kind: 'summary' | 'review' | 'retrospective'; objectRef?: string; content: string; sourceRefs: string[]; coverage: string; missing: string[]; createdAt: string; inputVersions: Record<string, number> }
export interface SupervisorAnalysis { intervals: Array<{ objectRef: string; kind: string; stage?: string; minutes: number | null; startEventId: string; endEventId: string; warning?: string }>; actualEffortMinutes: number | null; missing: string[]; computedAt: string }
export interface SupervisorSession extends LiveSessionSummary { observation: 'running' | 'idle' | 'stale' | 'offline' | 'waiting_input' | 'error' | 'unknown'; evidence: string; lastText?: string; digest?: SupervisorSessionDigest }
/**
 * Derived summary of a session's recent output, added only so the raw transcript is readable. Every
 * field is a verbatim excerpt from recent assistant text: it is evidence to inspect, never task fact,
 * and the untouched raw tail stays available on the same object.
 */
export interface SupervisorSessionDigest {
  headline?: string; points: string[]; waitingFor?: string; nextStep?: string
  coveredMessages: number; source: 'recent_output'
}
export interface SupervisorWorkingState {
  objectRef: string; stage?: string; nextStep?: string; waitingFor?: string
  sourceEventId: string; sourceKind: SupervisorSource['kind']; version: number; updatedAt: string
}
export interface SupervisorState {
  enabled: boolean; mode: SupervisorMode; agent: { sessionId?: string; processInstanceId?: string; connected: boolean; resourceState: 'disabled' | 'not_started' | 'loaded' | 'pending' | 'error'; revision?: string; /** Extension sources changed since this session started: usable, but a restart is needed to load the new code. */ extensionsStale?: boolean; error?: string }
  tasks: TasksResponse; sessions: SupervisorSession[]; events: SupervisorEvent[]; actions: SupervisorAction[]; reports: SupervisorReport[]; workingStates?: Record<string, SupervisorWorkingState>; archivedObjectRefs?: string[]; warnings: string[]; sampledAt: string
}
export interface SupervisorRequest { operation: SupervisorOperation; args?: Record<string, unknown> }
export interface SupervisorContext { actor: string; sessionId?: string; messageRef?: string; userInitiated: boolean; confirmed?: boolean }
export interface SupervisorTaskPatch { uid: string; status?: Completion; title?: string; description?: string }
