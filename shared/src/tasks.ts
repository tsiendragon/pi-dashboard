/**
 * Unified task model — provider-agnostic (see docs/tasks-page-design.md).
 *
 * Three orthogonal layers:
 *   fact (read-only, slow)  → TaskFact
 *   planning (writable, medium) → PlanningEntry / PlanningOverlay  (user × task)
 *   execution (fast) → SessionRef, attached by cwd
 *
 * "long/short/adhoc" is a *view* concept (LaneDef), never a data field.
 */

export type TaskKind = 'epic' | 'task' | 'todo' | 'item'
export type Completion = 'todo' | 'doing' | 'done' | 'paused'

/** Stage progress parsed from a taskspace `stage-dag.yaml`: how many stages closed, which is running. */
export interface TaskStageProgress { done: number; total: number; active?: string }

/** Coarse bucket of a Jira status, used for the dot colour and for drift checks. */
export type JiraCategory = 'todo' | 'inprogress' | 'done' | 'unknown'

/** One ticket's state as read from Jira by `acli` and cached locally. */
export interface JiraStatus {
  name: string
  category: JiraCategory
  assignee?: string
  priority?: string
  /** When this value was read from Jira (ISO). */
  readAt: string
}

export interface TaskProgress {
  done: number
  total: number
}

export interface TaskFact {
  /** `${providerId}:${id}` — must be stable for plannable tasks. */
  uid: string
  providerId: string
  id: string
  kind: TaskKind
  parentUid?: string
  parentTitle?: string
  title: string
  description?: string
  completion: Completion
  /** Original upstream value when it did not map cleanly (e.g. `Feasibility`). */
  completionRaw?: string
  archived: boolean
  /** Stable identity ⇒ may enter the planning set. */
  plannable: boolean
  /** Execution directory — the robust link to sessions. */
  path?: string
  /** Jira issue key when the source knows one (`PROJ-104`). Absent ⇒ no ticket, which is normal. */
  jiraKey?: string
  /** Ready-to-open Jira URL; only built when a base is configured, so it is absent for unconfigured deployments. */
  jiraUrl?: string
  /** Ticket state from the local Jira cache (never fetched while rendering). */
  jiraStatus?: JiraStatus
  /** taskspace stage progress; absent when the task has no `stage-dag.yaml`. */
  stage?: TaskStageProgress
  progress?: TaskProgress
  tags: string[]
  updatedAt?: string
  writable: boolean
  /** Human label of the source provider (for badges when >1 provider). */
  sourceLabel: string
  raw?: unknown
}

export interface PlanningEntry {
  priority?: 0 | 1 | 2
  focusOrder?: number
  pinned?: boolean
  note?: string
  sessionIds?: string[]
  laneOverride?: string
}

export type PlanningOverlay = Record<string, PlanningEntry>

export interface ProviderCapabilities {
  writable: boolean
  providesTodos: boolean
  providesProgress: boolean
}

export interface ProviderDescriptor {
  id: string
  label: string
  type: string
  available: boolean
  capabilities: ProviderCapabilities
}

export interface SessionRef {
  sessionId: string
  processInstanceId: string
  cwd: string
  title?: string
  tags: string[]
  live: boolean
}

export interface LaneDef {
  id: string
  label: string
  match: { kind?: TaskKind[]; tag?: string; pathPrefix?: string }
}

export type TaskViewMode = 'execute' | 'survey'

export interface TasksConfig {
  enabled: boolean
  journal: { autoDetect: boolean; roots: string[]; enabled: boolean }
  lanes: LaneDef[]
  defaultView: TaskViewMode
  /**
   * Where a Jira issue key opens, e.g. `https://example.atlassian.net/browse/`. Trailing slash optional.
   * There is no built-in default: unset means no ticket links are rendered.
   */
  jiraBaseUrl?: string
  /** Config-declared external sources (no code change needed to add one). */
  providers?: ExternalProviderConfig[]
}

/**
 * A read-only external task source declared in config.
 *
 * `command` runs an executable and reads its stdout; `file` reads a JSON file.
 * Both expect `[...]` or `{ "tasks": [...] }` where each item is:
 * `{ id, title, kind?, status?, archived?, path?, tags?, description?, updatedAt?, progress? }`.
 */
export type ExternalProviderConfig =
  | { kind: 'command'; id: string; label: string; command: string[]; cwd?: string; timeoutMs?: number; enabled?: boolean }
  | { kind: 'file'; id: string; label: string; file: string; enabled?: boolean }

export interface TasksResponse {
  tasks: TaskFact[]
  planning: PlanningOverlay
  providers: ProviderDescriptor[]
  sessionRefs: Record<string, SessionRef[]>
  warnings: string[]
  lanes: LaneDef[]
  defaultView: TaskViewMode
  /** Freshness of the Jira statuses attached to `tasks`; refreshing is an explicit user action. */
  jira?: { available: boolean; readAt?: string; stale: boolean; error?: string }
}

/** Point-in-time counts of non-archived tasks by completion (plus archived). */
export interface TaskCounts {
  total: number
  todo: number
  doing: number
  done: number
  paused: number
  archived: number
}

/** One daily snapshot. `date` is local `YYYY-MM-DD`. */
export interface HistoryPoint extends TaskCounts {
  date: string
}

export interface TasksHistoryResponse {
  points: HistoryPoint[]
}
