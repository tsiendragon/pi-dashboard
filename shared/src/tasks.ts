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
