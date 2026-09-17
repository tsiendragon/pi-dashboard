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

export interface TaskServiceOptions {
  getConfig: () => TasksConfig
  listLiveSessions: () => LiveSessionInput[]
  planningStore?: PlanningStore
  historyStore?: HistoryStore
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
    const providers = this.buildProviders(cfg)
    const results = await Promise.all(providers.map(p => this.runProvider(p)))

    const tasks: TaskFact[] = []
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
      tasks.push(...r.tasks)
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
