import type {
  LaneDef,
  PlanningOverlay,
  ProviderDescriptor,
  SessionRef,
  TaskCounts,
  TaskFact,
  TasksConfig,
  TasksResponse,
} from '@shared/tasks.js'
import type { TaskProvider, ProviderResult, TaskCreateInput, TaskUpdateInput } from './types.js'
import { PlanningStore } from './planning-store.js'
import { HistoryStore } from './history-store.js'
import { LocalTaskProvider } from './providers/local.js'
import { TaskJournalProvider } from './providers/task-journal.js'
import { detectJournalRoots } from './detect.js'
import { ExternalTaskProvider } from './providers/external.js'
import { linkSessions, type LiveSessionInput } from './session-linker.js'
import { JiraStatusStore } from '../jira/status.js'
import type { JiraStatus } from '@shared/tasks.js'

/** Fallback browse base when `tasks.jiraBaseUrl` is absent; only the prefix matters, the key is appended. */
export const DEFAULT_JIRA_BASE = 'https://example.atlassian.net/browse/'

export interface TaskServiceOptions {
  getConfig: () => TasksConfig
  listLiveSessions: () => LiveSessionInput[]
  planningStore?: PlanningStore
  historyStore?: HistoryStore
  /** Jira status cache; omitted in tests and in any deployment that does not want acli reads. */
  jira?: JiraStatusStore
}

/** Epic rollups and parent titles need the whole set, so they are computed once per snapshot. */
function withHierarchy(tasks: TaskFact[]): TaskFact[] {
  const byUid = new Map(tasks.map(task => [task.uid, task]))
  const rollup = new Map<string, { done: number; total: number }>()
  for (const task of tasks) {
    if (!task.parentUid) continue
    const current = rollup.get(task.parentUid) ?? { done: 0, total: 0 }
    current.total += 1
    if (task.completion === 'done') current.done += 1
    rollup.set(task.parentUid, current)
  }
  return tasks.map(task => {
    const progress = rollup.get(task.uid)
    const parent = task.parentUid ? byUid.get(task.parentUid) : undefined
    if (!progress && (!parent || task.parentTitle)) return task
    return { ...task, ...(progress ? { progress } : {}), ...(parent && !task.parentTitle ? { parentTitle: parent.title } : {}) }
  })
}

export interface PlanningUpdateResult {
  version: number
  overlay: PlanningOverlay
  rejected: string[]
  conflict?: boolean
}

/**
 * Provider-agnostic aggregation + planning overlay. The only place that knows
 * about providers; everything downstream (routes, frontend) sees TasksResponse.
 */
export class TaskService {
  private readonly store: PlanningStore
  private readonly history: HistoryStore

  constructor(private readonly options: TaskServiceOptions) {
    this.store = options.planningStore ?? new PlanningStore()
    this.history = options.historyStore ?? new HistoryStore()
  }

  /** Count non-archived tasks by completion (plus archived total). */
  private countTasks(tasks: TaskFact[]): TaskCounts {
    const counts: TaskCounts = { total: 0, todo: 0, doing: 0, done: 0, paused: 0, archived: 0 }
    for (const t of tasks) {
      if (t.archived) { counts.archived += 1; continue }
      counts.total += 1
      counts[t.completion] += 1
    }
    return counts
  }

  private buildProviders(cfg: TasksConfig): TaskProvider[] {
    const providers: TaskProvider[] = []
    if (cfg.journal.enabled) {
      const detected = detectJournalRoots(cfg.journal)
      const picked = cfg.journal.autoDetect ? detected.find(d => d.ok) : detected[0]
      if (picked) providers.push(new TaskJournalProvider(picked.root))
    }
    for (const p of cfg.providers ?? []) {
      if (p.enabled === false) continue
      providers.push(new ExternalTaskProvider(p))
    }
    providers.push(new LocalTaskProvider())
    return providers
  }

  private async runProvider(provider: TaskProvider): Promise<ProviderResult> {
    const base = {
      providerId: provider.id,
      label: provider.label,
      type: provider.type,
      capabilities: provider.capabilities,
    }
    try {
      const available = await provider.available()
      if (!available) return { ...base, available: false, tasks: [], warning: `${provider.label}: source unavailable` }
      return { ...base, available: true, tasks: await provider.list() }
    } catch (error) {
      return { ...base, available: false, tasks: [], warning: `${provider.label}: ${(error as Error).message}` }
    }
  }

  async snapshot(): Promise<TasksResponse> {
    const cfg = this.options.getConfig()
    // One place builds the ticket URL: providers only report the key, so a moved Jira is one config change.
    const jiraBase = (cfg.jiraBaseUrl || DEFAULT_JIRA_BASE).replace(/\/+$/, '') + '/'
    const withJiraUrl = (task: TaskFact): TaskFact => task.jiraKey ? { ...task, jiraUrl: jiraBase + encodeURIComponent(task.jiraKey) } : task
    const providers = this.buildProviders(cfg)
    const results = await Promise.all(providers.map(p => this.runProvider(p)))

    let tasks: TaskFact[] = []
    const warnings: string[] = []
    const descriptors: ProviderDescriptor[] = []
    for (const r of results) {
      descriptors.push({
        id: r.providerId,
        label: r.label,
        type: r.type,
        available: r.available,
        capabilities: r.capabilities,
      })
      if (r.warning) warnings.push(r.warning)
      tasks.push(...r.tasks.map(withJiraUrl))
    }
    tasks = withHierarchy(tasks)

    // Jira statuses come from the local cache only: rendering a page must never wait on `acli`.
    let jira: TasksResponse['jira']
    if (this.options.jira) {
      const keys = tasks.map(task => task.jiraKey).filter((key): key is string => !!key)
      if (keys.length) {
        const cached = await this.options.jira.peek(keys)
        jira = cached.meta
        tasks = tasks.map(task => (task.jiraKey && cached.statuses[task.jiraKey] ? { ...task, jiraStatus: cached.statuses[task.jiraKey] } : task))
      }
    }

    const { overlay } = await this.store.snapshot()
    const manual: Record<string, string[]> = {}
    for (const [uid, entry] of Object.entries(overlay)) {
      if (entry.sessionIds?.length) manual[uid] = entry.sessionIds
    }

    let sessionRefs: Record<string, SessionRef[]> = {}
    try {
      sessionRefs = linkSessions(tasks, this.options.listLiveSessions(), manual)
    } catch (error) {
      warnings.push(`session link failed: ${(error as Error).message}`)
    }

    // Best-effort daily snapshot for the trend view; never breaks the read path.
    await this.history.record(this.countTasks(tasks)).catch(() => {})

    return {
      tasks,
      planning: overlay,
      providers: descriptors,
      sessionRefs,
      warnings,
      lanes: cfg.lanes as LaneDef[],
      defaultView: cfg.defaultView,
      ...(jira ? { jira } : {}),
    }
  }

  async get(uid: string): Promise<TaskFact | null> {
    const providers = this.buildProviders(this.options.getConfig())
    for (const provider of providers) {
      const id = uid.startsWith(`${provider.id}:`) ? uid.slice(provider.id.length + 1) : null
      if (id && provider.get) {
        const task = await provider.get(id).catch(() => null)
        if (task) return task
      }
    }
    return null
  }

  /**
   * Keys an explicit refresh should ask acli for: tickets that are still open.
   *
   * Closed and archived tasks would only cost time — they cannot drift in a way anybody still acts on,
   * and they are roughly half of the journal. Their cached status stays visible either way.
   */
  async jiraRefreshKeys(): Promise<{ keys: string[]; skippedDone: number; skippedArchived: number }> {
    const snapshot = await this.snapshot()
    // A child of an archived epic is history too, even though the journal never marks tasks archived.
    const archivedUids = new Set(snapshot.tasks.filter(task => task.archived).map(task => task.uid))
    const keys = new Set<string>()
    let skippedDone = 0
    let skippedArchived = 0
    for (const task of snapshot.tasks) {
      if (!task.jiraKey) continue
      if (task.archived || (task.parentUid && archivedUids.has(task.parentUid))) { skippedArchived += 1; continue }
      if (task.completion === 'done') { skippedDone += 1; continue }
      keys.add(task.jiraKey)
    }
    return { keys: [...keys], skippedDone, skippedArchived }
  }

  /**
   * Explicit refresh: the only path that runs acli. Never throws on a read error, and never clears the
   * previous values — the page keeps showing what it already had (plus the error) until a read succeeds.
   */
  async refreshJira(): Promise<{ statuses: Record<string, JiraStatus>; meta: NonNullable<TasksResponse['jira']>; scope: { keys: number; skippedDone: number; skippedArchived: number } }> {
    if (!this.options.jira) {
      return { statuses: {}, meta: { available: false, stale: false, error: 'jira_disabled' }, scope: { keys: 0, skippedDone: 0, skippedArchived: 0 } }
    }
    const { keys, skippedDone, skippedArchived } = await this.jiraRefreshKeys()
    const result = await this.options.jira.refresh(keys)
    return { ...result, scope: { keys: keys.length, skippedDone, skippedArchived } }
  }

  async planning(): Promise<{ version: number; overlay: PlanningOverlay }> {
    return this.store.snapshot()
  }

  /** Chronological daily count snapshots (trend/burndown). */
  async historySeries(days = 30): Promise<import('@shared/tasks.js').HistoryPoint[]> {
    return this.history.series(days)
  }

  async updatePlanning(patch: PlanningOverlay, expectedVersion?: number): Promise<PlanningUpdateResult> {
    const providers = this.buildProviders(this.options.getConfig())
    const results = await Promise.all(providers.map(p => this.runProvider(p)))
    const plannable = new Set<string>()
    for (const r of results) for (const t of r.tasks) if (t.plannable) plannable.add(t.uid)

    const accepted: PlanningOverlay = {}
    const rejected: string[] = []
    for (const [uid, entry] of Object.entries(patch)) {
      if (plannable.has(uid)) accepted[uid] = entry
      else rejected.push(uid)
    }

    const merged = await this.store.merge(accepted, expectedVersion)
    if (!merged) {
      const current = await this.store.snapshot()
      return { version: current.version, overlay: current.overlay, rejected, conflict: true }
    }
    return { version: merged.version, overlay: merged.overlay, rejected }
  }

  /** Split a `providerId:rest` uid into its parts. */
  private splitUid(uid: string): { providerId: string; id: string } {
    const idx = uid.indexOf(':')
    return idx < 0 ? { providerId: '', id: uid } : { providerId: uid.slice(0, idx), id: uid.slice(idx + 1) }
  }

  private providerById(providerId: string): TaskProvider | undefined {
    return this.buildProviders(this.options.getConfig()).find(p => p.id === providerId)
  }

  /** Create a task in the first writable provider (the local inbox). */
  async createTask(input: TaskCreateInput): Promise<TaskFact> {
    const provider = this.buildProviders(this.options.getConfig()).find(p => p.capabilities.writable && p.createTask)
    if (!provider?.createTask) throw new Error('no_writable_provider')
    if (!input.title?.trim()) throw new Error('title_required')
    return provider.createTask({ ...input, title: input.title.trim() })
  }

  /** Update a task; only allowed for writable sources (local), else throws read_only_source. */
  async updateTask(uid: string, patch: TaskUpdateInput): Promise<TaskFact> {
    const { providerId, id } = this.splitUid(uid)
    const provider = this.providerById(providerId)
    if (!provider?.updateTask) throw new Error(provider ? 'read_only_source' : 'provider_not_found')
    const task = await provider.updateTask(id, patch)
    if (!task) throw new Error('task_not_found')
    return task
  }

  async deleteTask(uid: string): Promise<void> {
    const { providerId, id } = this.splitUid(uid)
    const provider = this.providerById(providerId)
    if (!provider?.deleteTask) throw new Error(provider ? 'read_only_source' : 'provider_not_found')
    const ok = await provider.deleteTask(id)
    if (!ok) throw new Error('task_not_found')
  }
}
