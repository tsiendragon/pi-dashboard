import { randomUUID } from 'node:crypto'
import type { TaskFact, TasksResponse } from '../../shared/src/tasks.js'
import type { SupervisorAction, SupervisorAnalysis, SupervisorConfig, SupervisorContext, SupervisorEvent, SupervisorEventList, SupervisorEventSummary, SupervisorReport, SupervisorRequest, SupervisorSession, SupervisorWorkingState } from '../../shared/src/supervisor.js'
import type { TaskService } from '../tasks/service.js'
import { payloadHash, SupervisorError, SupervisorStore, validateId, type SupervisorArchive } from './store.js'
import { SUPERVISOR_STANDARD_EVENT_TYPES, SUPERVISOR_SYSTEM_EVENT_TYPES } from '../../shared/src/supervisor.js'

export interface SupervisorServiceOptions {
  store: SupervisorStore
  taskService: TaskService
  getConfig: () => SupervisorConfig
  listSessions: () => SupervisorSession[]
}
const now = () => new Date().toISOString()
const fail = (status: number, code: string, message?: string): never => { throw new SupervisorError(status, code, message) }
function str(value: unknown, field: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim())) return fail(400, 'invalid_arguments', `${field} must be a ${required ? 'nonempty ' : ''}string`)
  return value
}
function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) return fail(400, 'invalid_arguments', `${field} must be a string array`)
  return [...new Set(value as string[])]
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_arguments')
  return value as Record<string, unknown>
}
function matches(uid: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(uid))
}
function occurred(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = str(value, 'occurredAt')
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(s)
  if (!m || !Number.isFinite(Date.parse(s))) return fail(400, 'invalid_time', 'Use a valid ISO date or timestamp with timezone')
  const day = new Date(`${s.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== s.slice(0, 10) || (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59))) return fail(400, 'invalid_time')
  return s
}
const MAX_EVENT_LIMIT = 200
const DEFAULT_EVENT_LIMIT = 50
/** Validates a listing boundary; a date-only `until` is inclusive of that whole day. */
function boundary(value: unknown, field: string, endOfDay: boolean): number {
  const invalid = (): never => fail(400, 'invalid_arguments', `${field} must be a valid ISO date or timestamp`)
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return invalid()
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return invalid()
  const dateOnly = value.length === 10
  const at = Date.parse(dateOnly ? `${value}T00:00:00Z` : value)
  if (!Number.isFinite(at)) return invalid()
  return endOfDay && dateOnly ? at + 86_399_999 : at
}
/** Unknown occurrence times stay last in both directions; never reverse a null-last comparator in place. */
function compareEvents(a: SupervisorEvent, b: SupervisorEvent, direction: 1 | -1): number {
  const tail = a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id)
  if (a.occurredAt === null || b.occurredAt === null) {
    if (a.occurredAt === null && b.occurredAt === null) return tail
    return a.occurredAt === null ? 1 : -1
  }
  const delta = Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
  return delta === 0 ? tail : direction * delta
}
function summarize(event: SupervisorEvent): SupervisorEventSummary {
  const { id, objectRef, objectSnapshot, title, type, occurredAt, recordedAt, recorder, participants, source, attachmentIds, version, interval } = event
  return {
    id, objectRef, ...(objectSnapshot ? { objectSnapshot } : {}), title, type, occurredAt, recordedAt,
    ...(recorder ? { recorder } : {}), participants, source, attachmentIds, version, ...(interval ? { interval } : {}),
  }
}
function expected(value: unknown, current: number): void {
  if (!Number.isInteger(value) || value !== current) return fail(409, 'version_conflict', `Current version is ${current}`)
}
function user(context: SupervisorContext): void {
  if (!context.userInitiated) return fail(403, 'user_request_required', 'A real user request is required; agent suggestions do not authorize task or state writes')
}
function completion(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!['todo', 'doing', 'paused', 'done'].includes(String(value))) return fail(400, 'invalid_status')
  return value as string
}

export class SupervisorService {
  constructor(private readonly options: SupervisorServiceOptions) {}

  private async tasks(): Promise<TasksResponse> {
    const original = await this.options.taskService.snapshot()
    const warnings = [...original.warnings]
    const unique = new Map<string, TaskFact>()
    const conflicts = new Set<string>()
    for (const t of original.tasks) {
      const provider = original.providers.find(p => p.id === t.providerId)
      if (!provider?.available) continue
      const prior = unique.get(t.uid)
      if (prior && payloadHash(prior) !== payloadHash(t)) {
        conflicts.add(t.uid)
        warnings.push(`Conflicting task UID ${t.uid}; fix provider identity before using this task`)
      } else unique.set(t.uid, t)
    }
    for (const uid of conflicts) unique.delete(uid)
    const allowed = new Set([...unique.values()].filter(t => matches(t.uid, this.options.getConfig().allowedObjects)).map(t => t.uid))
    // Configured epics include their descendants, by UID rather than title or filesystem path.
    let changed = true
    while (changed) {
      changed = false
      for (const t of unique.values()) if (t.parentUid && allowed.has(t.parentUid) && !allowed.has(t.uid)) { allowed.add(t.uid); changed = true }
    }
    const tasks = [...unique.values()].filter(t => allowed.has(t.uid))
    for (const t of tasks) {
      const seen = new Set([t.uid])
      let parent = t.parentUid
      while (parent && unique.has(parent)) {
        if (seen.has(parent)) { warnings.push(`Task hierarchy cycle at ${t.uid}`); break }
        seen.add(parent)
        parent = unique.get(parent)!.parentUid
      }
    }
    const sessionAllowed = this.options.getConfig().allowedSessionIds
    return { ...original, tasks, warnings: [...new Set(warnings)], planning: Object.fromEntries(Object.entries(original.planning).filter(([uid]) => allowed.has(uid))), sessionRefs: Object.fromEntries(Object.entries(original.sessionRefs).filter(([uid]) => allowed.has(uid)).map(([uid, refs]) => [uid, refs.filter(r => matches(r.sessionId, sessionAllowed))])), providers: original.providers }
  }

  private task(tasks: TasksResponse, ref: unknown, stable = true): TaskFact {
    const uid = str(ref, 'objectRef')
    const task = tasks.tasks.find(t => t.uid === uid)
    if (!task) return fail(403, 'object_not_allowed', 'Task is unavailable, ambiguous or outside the allowed object scope')
    if (stable && !task.plannable) return fail(400, 'unstable_object', 'Create a stable local task before attaching an archive')
    return task
  }

  private select(tasks: TasksResponse, ref: unknown, children: unknown): Set<string> {
    if (ref === undefined) return new Set(tasks.tasks.map(t => t.uid))
    const task = this.task(tasks, ref, false)
    const refs = new Set([task.uid])
    if (children === true || (children === undefined && task.kind === 'epic')) {
      let changed = true
      while (changed) {
        changed = false
        for (const t of tasks.tasks) if (t.parentUid && refs.has(t.parentUid) && !refs.has(t.uid)) { refs.add(t.uid); changed = true }
      }
    }
    return refs
  }

  private selectEvents(tasks: TasksResponse, objectRef: unknown, includeChildren: unknown, events: SupervisorEvent[]): Set<string> {
    if (objectRef === undefined) return new Set([...tasks.tasks.map(t => t.uid), ...events.map(e => e.objectRef)])
    const ref = str(objectRef, 'objectRef')
    const rootKnown = events.some(e => e.objectRef === ref || (matches(ref, this.options.getConfig().allowedObjects) && (e.objectSnapshot?.ancestorUids?.includes(ref) || e.objectSnapshot?.parentUid === ref)))
    const refs = tasks.tasks.some(t => t.uid === ref) ? this.select(tasks, ref, includeChildren) : rootKnown ? new Set([ref]) : fail(403, 'outside_scope', 'Object is unavailable or outside the authorized archive scope')
    if (includeChildren === true) for (const e of events) if (e.objectSnapshot?.ancestorUids?.some(parent => refs.has(parent)) || (e.objectSnapshot?.parentUid && refs.has(e.objectSnapshot.parentUid))) refs.add(e.objectRef)
    return refs
  }
  private visible(archive: SupervisorArchive, tasks: TasksResponse) {
    const currentRefs = new Set(tasks.tasks.map(t => t.uid))
    const events = archive.events.filter(e => [e.objectRef, ...(e.objectSnapshot?.ancestorUids || []), ...(e.objectSnapshot?.parentUid ? [e.objectSnapshot.parentUid] : [])].some(ref => currentRefs.has(ref) || matches(ref, this.options.getConfig().allowedObjects)))
    const archiveGroups = events.flatMap(e => [...(e.objectSnapshot?.ancestorUids || []), ...(e.objectSnapshot?.parentUid ? [e.objectSnapshot.parentUid] : [])]).filter(ref => matches(ref, this.options.getConfig().allowedObjects))
    const refs = new Set([...currentRefs, ...events.map(e => e.objectRef), ...archiveGroups])
    const visibleSources = new Set([...refs, ...events.map(e => e.id)])
    const sourceAllowed = (sourceRefs: string[]) => sourceRefs.every(r => visibleSources.has(r))
    const actions = archive.actions.filter(a => (!a.objectRef || refs.has(a.objectRef)) && sourceAllowed(a.sourceRefs))
    const reports = archive.reports.filter(r => (!r.objectRef || refs.has(r.objectRef)) && sourceAllowed(r.sourceRefs))
    const orphaned = events.filter(e => !currentRefs.has(e.objectRef)).length
    const staleReports = reports.filter(r => Object.entries(r.inputVersions).some(([id, version]) => archive.events.find(e => e.id === id)?.version !== version) || events.some(e => e.recordedAt > r.createdAt && (!r.objectRef || e.objectRef === r.objectRef || e.objectSnapshot?.ancestorUids?.includes(r.objectRef) || r.sourceRefs.some(ref => archive.events.find(source => source.id === ref)?.objectRef === e.objectRef))))
    return { events, actions, reports, warnings: [...tasks.warnings, ...(orphaned ? [`${orphaned} archived events have unavailable source objects; authorized history remains readable, but new writes require the source to be restored`] : []), ...staleReports.map(r => `Report ${r.id} has changed or newly recorded source data; review coverage and regenerate it before relying on current conclusions`)] }
  }

  private workingStates(events: SupervisorEvent[]): Record<string, SupervisorWorkingState> {
    return Object.fromEntries(events.filter(e => e.type === 'working_state' && e.source.kind !== 'agent').map(e => [e.objectRef, { objectRef: e.objectRef, stage: e.stage, nextStep: e.nextStep, waitingFor: e.waitingFor, sourceEventId: e.id, sourceKind: e.source.kind, version: e.version, updatedAt: e.recordedAt }]))
  }
  async stateData(): Promise<{ tasks: TasksResponse; events: SupervisorEvent[]; actions: SupervisorAction[]; reports: SupervisorReport[]; workingStates: Record<string, SupervisorWorkingState>; archivedObjectRefs: string[]; warnings: string[] }> {
    const [tasks, archive] = await Promise.all([this.tasks(), this.options.store.snapshot()])
    const visible = this.visible(archive, tasks)
    const archivedObjectRefs = [...new Set(visible.events.flatMap(e => [e.objectRef, ...(e.objectSnapshot?.ancestorUids || []), ...(e.objectSnapshot?.parentUid ? [e.objectSnapshot.parentUid] : [])].filter(ref => ref === e.objectRef || matches(ref, this.options.getConfig().allowedObjects))))].filter(ref => !tasks.tasks.some(t => t.uid === ref))
    return { tasks, ...visible, workingStates: this.workingStates(visible.events), archivedObjectRefs }
  }

  private sourceRefs(value: unknown, archive: SupervisorArchive, tasks: TasksResponse): string[] {
    const refs = stringList(value, 'sourceRefs')
    const visible = this.visible(archive, tasks)
    for (const ref of refs) if (!tasks.tasks.some(t => t.uid === ref) && !visible.events.some(e => e.id === ref || e.objectRef === ref)) return fail(400, 'invalid_source_ref', 'Source must reference an accessible task or event')
    return refs
  }

  private objectSnapshot(task: TaskFact, tasks: TasksResponse) {
    const ancestorUids: string[] = [], seen = new Set([task.uid])
    let parent = task.parentUid
    while (parent && !seen.has(parent)) { ancestorUids.push(parent); seen.add(parent); parent = tasks.tasks.find(t => t.uid === parent)?.parentUid }
    return { title: task.title, kind: task.kind, parentUid: task.parentUid, ancestorUids }
  }
  /** Shared listing path for the agent query operation and the truncated context listing. */
  private listEvents(events: SupervisorEvent[], args: Record<string, unknown>): SupervisorEventList {
    const limit = args.limit === undefined ? DEFAULT_EVENT_LIMIT : args.limit
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_EVENT_LIMIT) return fail(400, 'invalid_arguments', `limit must be an integer between 1 and ${MAX_EVENT_LIMIT}`)
    const order = args.order === undefined ? 'desc' : args.order
    if (order !== 'asc' && order !== 'desc') return fail(400, 'invalid_arguments', "order must be 'asc' or 'desc'")
    const view = args.view === undefined ? 'summary' : args.view
    if (view !== 'summary' && view !== 'full') return fail(400, 'invalid_arguments', "view must be 'summary' or 'full'")
    const types = this.eventTypes(args.types, events)
    const since = args.since === undefined ? null : boundary(args.since, 'since', false)
    const until = args.until === undefined ? null : boundary(args.until, 'until', true)
    if (since !== null && until !== null && since > until) return fail(400, 'invalid_arguments', 'since must not be later than until')
    let selected = types ? events.filter(event => types.includes(event.type)) : events
    let excludedWithoutTime = 0
    if (since !== null || until !== null) {
      const timed: SupervisorEvent[] = []
      for (const event of selected) {
        if (event.occurredAt === null) { excludedWithoutTime += 1; continue }
        const at = Date.parse(event.occurredAt)
        if (since !== null && at < since) continue
        if (until !== null && at > until) continue
        timed.push(event)
      }
      selected = timed
    }
    const sorted = [...selected].sort((a, b) => compareEvents(a, b, order === 'asc' ? 1 : -1))
    const page = sorted.slice(0, limit as number)
    return { events: view === 'full' ? page : page.map(summarize), total: sorted.length, truncated: sorted.length > page.length, excludedWithoutTime }
  }
  /** Filter vocabulary: configured types, system types, and types already stored so history stays queryable. */
  private eventTypes(value: unknown, events: SupervisorEvent[]): string[] | null {
    if (value === undefined) return null
    if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) return fail(400, 'invalid_arguments', 'types must be a nonempty string array')
    const requested = [...new Set((value as string[]).map(item => item.trim()))]
    const known = new Set([...(this.options.getConfig().eventTypes ?? SUPERVISOR_STANDARD_EVENT_TYPES), ...SUPERVISOR_SYSTEM_EVENT_TYPES, ...events.map(event => event.type)])
    const unknown = requested.filter(type => !known.has(type))
    if (unknown.length) return fail(400, 'invalid_event_type', `Event type must be one of: ${[...known].sort().join(', ')}`)
    return requested
  }
  /** Event categories come from the configured vocabulary; system types and an event's own unchanged type stay valid. */
  private eventType(value: unknown, stored?: SupervisorEvent): string {
    const type = str(value, 'type')
    if (SUPERVISOR_SYSTEM_EVENT_TYPES.includes(type) || type === stored?.type) return type
    const allowed = this.options.getConfig().eventTypes ?? SUPERVISOR_STANDARD_EVENT_TYPES
    if (allowed.includes(type)) return type
    return fail(400, 'invalid_event_type', `Event type must be one of: ${[...allowed, ...SUPERVISOR_SYSTEM_EVENT_TYPES].join(', ')}`)
  }
  private eventFields(args: Record<string, unknown>, archive: SupervisorArchive, tasks: TasksResponse, stored?: SupervisorEvent) {
    const task = stored ? tasks.tasks.find(t => t.uid === args.objectRef) : this.task(tasks, args.objectRef)
    const objectRef = task?.uid ?? stored!.objectRef
    const attachmentIds = stringList(args.attachmentIds, 'attachmentIds')
    if (attachmentIds.length > 4) return fail(400, 'too_many_attachments')
    let bytes = 0
    for (const id of attachmentIds) {
      validateId(id)
      const attachment = archive.attachments.find(a => a.id === id)
      if (!attachment) return fail(400, 'invalid_attachment', 'Upload evidence first and use the returned attachment ID')
      bytes += attachment.bytes
    }
    if (bytes > 6 * 1024 * 1024) return fail(413, 'attachments_too_large')
    let interval: SupervisorEvent['interval']
    if (args.interval !== undefined && args.interval !== null) {
      const input = record(args.interval)
      if (!['wait', 'stage', 'effort'].includes(String(input.kind))) return fail(400, 'invalid_interval')
      const startEventId = validateId(input.startEventId)
      if (!archive.events.some(e => e.id === startEventId && e.objectRef === objectRef)) return fail(400, 'invalid_interval_link')
      if (input.durationMinutes !== undefined && (typeof input.durationMinutes !== 'number' || !Number.isFinite(input.durationMinutes) || input.durationMinutes < 0 || input.kind !== 'effort')) return fail(400, 'invalid_duration')
      interval = { kind: input.kind as 'wait' | 'stage' | 'effort', startEventId, ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes as number } : {}) }
    }
    const sourceKind = args.sourceKind ?? (record(args.source ?? {}).kind)
    if (sourceKind !== undefined && !['user', 'relay', 'agent'].includes(String(sourceKind))) return fail(400, 'invalid_source_kind')
    return { objectSnapshot: stored?.objectSnapshot ?? (task ? this.objectSnapshot(task, tasks) : undefined), sourceKind: sourceKind as SupervisorEvent['source']['kind'] | undefined, objectRef, title: str(args.title, 'title'), type: this.eventType(args.type, stored), description: str(args.description ?? '', 'description', false), occurredAt: occurred(args.occurredAt), participants: stringList(args.participants, 'participants'), attachmentIds, interval, originalReply: args.originalReply === undefined ? undefined : str(args.originalReply, 'originalReply', false), nextStep: args.nextStep === undefined ? undefined : str(args.nextStep, 'nextStep', false), stage: args.stage === undefined ? undefined : str(args.stage, 'stage', false), waitingFor: args.waitingFor === undefined ? undefined : str(args.waitingFor, 'waitingFor', false) }
  }

  private append(archive: SupervisorArchive, fields: ReturnType<SupervisorService['eventFields']>, requestId: string, hash: string, context: SupervisorContext): SupervisorEvent {
    const event: SupervisorEvent = { ...fields, id: randomUUID(), recordedAt: now(), recorder: context.actor, source: { kind: context.userInitiated ? fields.sourceKind ?? 'user' : 'agent', ...(context.sessionId ? { sessionId: context.sessionId } : {}), ...(context.messageRef ? { messageRef: context.messageRef } : {}) }, version: 1, revisions: [], requestId, payloadHash: hash }
    archive.events.push(event)
    return event
  }

  private analyze(events: SupervisorEvent[]): SupervisorAnalysis {
    const intervals: SupervisorAnalysis['intervals'] = []
    const missing: string[] = []
    let effort = 0
    let effortKnown = false
    let effortIncomplete = false
    for (const end of events) {
      if (!end.interval) continue
      const link = end.interval
      const start = events.find(e => e.id === link.startEventId && e.objectRef === end.objectRef)
      let minutes: number | null = null
      let warning: string | undefined
      if (!start || start.id === end.id) warning = 'Missing or invalid explicit start event'
      else if (start.type === 'suggestion' || end.type === 'suggestion') warning = 'Suggested events are not confirmed facts and cannot be timed'
      else if (link.kind === 'effort') {
        if (link.durationMinutes !== undefined && Number.isFinite(link.durationMinutes) && link.durationMinutes >= 0) { minutes = link.durationMinutes; effort += minutes; effortKnown = true }
        else warning = 'Actual effort needs an explicit duration; elapsed time is not effort'
      } else if (!start.occurredAt || !end.occurredAt || !/T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(start.occurredAt) || !/T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(end.occurredAt)) warning = 'Both events need timestamp precision and timezone; date-only or unknown times cannot be timed'
      else {
        const a = Date.parse(start.occurredAt), b = Date.parse(end.occurredAt)
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) warning = 'Invalid or reversed interval timestamps'
        else minutes = (b - a) / 60000
      }
      if (link.kind === 'effort' && warning) effortIncomplete = true
      if (warning) missing.push(`${end.id}: ${warning}`)
      intervals.push({ objectRef: end.objectRef, kind: link.kind, stage: end.stage, minutes, startEventId: link.startEventId, endEventId: end.id, ...(warning ? { warning } : {}) })
    }
    if (!effortKnown) missing.push('No explicit actual effort duration recorded')
    return { intervals, actualEffortMinutes: effortKnown && !effortIncomplete ? effort : null, missing, computedAt: now() }
  }

  async execute(request: SupervisorRequest, context: SupervisorContext): Promise<unknown> {
    if (!this.options.getConfig().enabled) return fail(403, 'supervisor_disabled')
    str(context.actor, 'actor')
    const args = request.args === undefined ? {} : record(request.args)
    if (request.operation === 'context') {
      const state = await this.stateData()
      const refs = this.selectEvents(state.tasks, args.objectRef, args.includeChildren, state.events)
      // Context is the agent's first call: list summaries only, or the query limits below would never bite.
      const listing = this.listEvents(state.events.filter(e => refs.has(e.objectRef)), { ...args, order: args.order ?? 'desc' })
      return { ...state, permissions: { mode: this.options.getConfig().agentResources.mode, allowedObjects: this.options.getConfig().allowedObjects, allowedSessionIds: this.options.getConfig().allowedSessionIds, allowedRoots: this.options.getConfig().allowedRoots }, tasks: { ...state.tasks, tasks: state.tasks.tasks.filter(t => refs.has(t.uid)), planning: Object.fromEntries(Object.entries(state.tasks.planning).filter(([uid]) => refs.has(uid))), sessionRefs: Object.fromEntries(Object.entries(state.tasks.sessionRefs).filter(([uid]) => refs.has(uid))) }, events: listing.events, eventsTotal: listing.total, eventsTruncated: listing.truncated, excludedWithoutTime: listing.excludedWithoutTime, archivedObjectRefs: state.archivedObjectRefs.filter(ref => refs.has(ref)), workingStates: Object.fromEntries(Object.entries(state.workingStates || {}).filter(([ref]) => refs.has(ref))), actions: state.actions.filter(a => !a.objectRef || refs.has(a.objectRef)), reports: state.reports.filter(r => !r.objectRef || refs.has(r.objectRef)), sessions: this.options.listSessions().filter(s => matches(s.sessionId, this.options.getConfig().allowedSessionIds)) }
    }
    const tasks = await this.tasks()
    if (request.operation === 'events' || request.operation === 'analyze' || request.operation === 'query') {
      const archive = await this.options.store.snapshot()
      const visible = this.visible(archive, tasks).events
      const refs = this.selectEvents(tasks, args.objectRef, args.includeChildren, visible)
      const events = visible.filter(e => refs.has(e.objectRef))
      if (request.operation === 'analyze') return this.analyze(events)
      if (request.operation === 'query') return this.listEvents(events, args)
      if (args.id !== undefined) {
        const event = events.find(e => e.id === validateId(args.id))
        if (!event) return fail(404, 'event_not_found')
        if (args.includeImages === undefined || args.includeImages === false) return event
        if (args.includeImages !== true) return fail(400, 'invalid_arguments', 'includeImages must be boolean')
        if (event.attachmentIds.length > 4) return fail(413, 'too_many_attachments')
        let bytes = 0
        const images = []
        for (const attachmentId of event.attachmentIds) {
          const { metadata, data } = await this.options.store.readAttachment(attachmentId)
          bytes += data.length
          if (bytes > 6 * 1024 * 1024) return fail(413, 'attachments_too_large')
          images.push({ attachmentId, mimeType: metadata.mime, data: data.toString('base64') })
        }
        return { event, images }
      }
      return events.slice().sort((a, b) => compareEvents(a, b, 1))
    }
    if (!['record', 'correct', 'task_create', 'task_update', 'working_state', 'action', 'report', 'attachment_put'].includes(request.operation)) return fail(400, 'unsupported_operation', 'inspect and coordinate are handled by the runtime')
    const patch = args.patch === undefined ? args : { ...args, ...record(args.patch) }
    const suggested = request.operation === 'action' && (patch.state ?? 'suggested') === 'suggested' && args.id === undefined
    if (request.operation === 'record' && args.type === 'working_state') return fail(400, 'dedicated_operation_required', 'Ordinary records must not silently update observation state')
    const agentSuggestion = request.operation === 'record' && args.type === 'suggestion'
    if (request.operation !== 'report' && !suggested && !agentSuggestion) user(context)
    // Screenshots the user attached to this turn are archived through the same store as browser uploads, so a
    // record can reference them by id. `store.uploadImage` re-checks the image magic, mime, name and size.
    if (request.operation === 'attachment_put') {
      const attachment = await this.options.store.uploadImage({ name: str(args.name ?? '截图', 'name'), mime: str(args.mime ?? '', 'mime'), data: Buffer.from(str(args.data, 'data'), 'base64') })
      return { attachmentId: attachment.id, bytes: attachment.bytes, mime: attachment.mime }
    }
    if (agentSuggestion && !context.userInitiated && args.interval != null) return fail(403, 'user_request_required', 'Agent interval suggestions must be confirmed by a user before entering statistics')
    // Validate mutation scope before idempotent replay as well as inside the transaction.
    if (request.operation === 'task_create') {
      const scope = this.options.getConfig().allowedObjects
      // LocalTaskProvider generates local:t-<random ID>; only scopes covering the
      // entire generated namespace can authorize creation before the ID exists.
      if (!scope.some(s => s.endsWith('*') && matches('local:t-', [s]))) return fail(403, 'create_outside_scope', 'Local creation requires a wildcard scope covering generated local task IDs')
      completion(patch.status)
    } else if (request.operation === 'task_update') {
      const target = this.task(tasks, args.uid ?? args.objectRef)
      const provider = tasks.providers.find(p => p.id === target.providerId)
      if (!target.writable || provider?.type !== 'local' || !provider.capabilities.writable) return fail(403, 'read_only_source', 'This source is read-only; use Task Pilot for task-journal, Jira or Lark writes')
      completion(patch.status)
    } else if (!['correct', 'report', 'action'].includes(request.operation) && patch.objectRef !== undefined) this.task(tasks, patch.objectRef)
    if (request.operation === 'action' && patch.state === 'done' && !context.userInitiated) return fail(403, 'user_request_required', 'A real user request is required; agent suggestions do not authorize state writes')
    const preflight = await this.options.store.snapshot()
    if (['report', 'action'].includes(request.operation) && patch.objectRef !== undefined) this.selectEvents(tasks, patch.objectRef, true, this.visible(preflight, tasks).events)
    if (request.operation === 'correct') {
      const event = preflight.events.find(e => e.id === validateId(args.id))
      if (!event) return fail(404, 'event_not_found')
      if (!this.visible(preflight, tasks).events.some(e => e.id === event.id)) return fail(403, 'outside_scope')
    }
    if (request.operation === 'action' && args.id !== undefined) {
      const action = preflight.actions.find(a => a.id === validateId(args.id))
      if (!action) return fail(404, 'action_not_found')
      if (action.objectRef) this.selectEvents(tasks, action.objectRef, true, this.visible(preflight, tasks).events)
      this.sourceRefs(action.sourceRefs, preflight, tasks)
      if ((patch.state ?? action.state) === 'done' && !context.userInitiated) return fail(403, 'user_request_required', 'A real user request is required; agent suggestions do not authorize state writes')
    }
    if (request.operation === 'action' || request.operation === 'report') this.sourceRefs(patch.sourceRefs, preflight, tasks)
    const requestId = validateId(args.requestId)
    // A stale client may still echo a confirmation flag inside args: it is data, never authorization.
    const { confirmed: _untrusted, ...cleanArgs } = args
    const payload = { operation: request.operation, args: cleanArgs, actor: context.actor, sessionId: context.sessionId, userInitiated: context.userInitiated }
    const hash = payloadHash(payload)
    return this.options.store.request(requestId, payload, async (archive, commit) => {
      if (request.operation === 'working_state') {
        const task = this.task(tasks, args.objectRef)
        const previous = this.workingStates(archive.events)[task.uid]
        if ((args.expectedEventId ?? null) !== (previous?.sourceEventId ?? null) || (previous && args.expectedVersion !== previous.version)) return fail(409, 'stale_version', 'Read the current observation state before updating it')
        if (args.stage === undefined && args.nextStep === undefined && args.waitingFor === undefined) return fail(400, 'invalid_arguments', 'Provide stage, nextStep or waitingFor')
        if (args.sourceKind === 'agent') return fail(400, 'invalid_source', 'Observation state must come from a user or relayed fact')
        const event = this.append(archive, this.eventFields({ ...args, type: 'working_state', title: '用户确认的本地观察状态', description: str(args.description, 'description'), stage: args.stage ?? previous?.stage, nextStep: args.nextStep ?? previous?.nextStep, waitingFor: args.waitingFor ?? previous?.waitingFor }, archive, tasks), requestId, hash, context)
        return { event, workingState: this.workingStates([event])[task.uid], sourceTaskUnchanged: true }
      }
      if (request.operation === 'record') return this.append(archive, this.eventFields(args, archive, tasks), requestId, hash, context)
      if (request.operation === 'correct') {
        const event = archive.events.find(e => e.id === validateId(args.id))
        if (!event) return fail(404, 'event_not_found')
        if (!this.visible(archive, tasks).events.some(e => e.id === event.id)) return fail(403, 'outside_scope')
        expected(args.expectedVersion, event.version)
        if (patch.type === 'working_state' && event.type !== 'working_state') return fail(400, 'dedicated_operation_required')
        if (patch.objectRef !== undefined && patch.objectRef !== event.objectRef) return fail(400, 'object_reassignment_forbidden')
        const fields = this.eventFields({ ...event, ...patch }, archive, tasks, event)
        if (fields.interval?.startEventId === event.id) return fail(400, 'invalid_interval_link')
        const { revisions: _revisions, ...previous } = event
        event.revisions.push({ version: event.version, at: now(), actor: context.actor, previous })
        Object.assign(event, fields, { objectSnapshot: event.objectSnapshot ?? fields.objectSnapshot, version: event.version + 1, requestId, payloadHash: hash })
        if (fields.sourceKind) event.source = { ...event.source, kind: fields.sourceKind }
        return event
      }
      if (request.operation === 'task_create' || request.operation === 'task_update') {
        const input = { ...(patch.title !== undefined ? { title: str(patch.title, 'title') } : {}), ...(patch.description !== undefined ? { description: str(patch.description, 'description', false) } : {}), ...(patch.status !== undefined ? { status: completion(patch.status) } : {}) }
        if (!Object.keys(input).length) return fail(400, 'empty_patch')
        const creation: { kind?: 'task' | 'epic' | 'todo' | 'item'; parentUid?: string; tags?: string[] } = {}
        if (request.operation === 'task_create') {
          if (patch.kind !== undefined) {
            if (!['task', 'epic', 'todo', 'item'].includes(String(patch.kind))) return fail(400, 'invalid_task_kind')
            creation.kind = patch.kind as typeof creation.kind
          } else creation.kind = 'task'
          if (patch.parentUid !== undefined) {
            const parent = this.task(tasks, patch.parentUid)
            if (parent.kind !== 'epic') return fail(400, 'parent_must_be_epic')
            creation.parentUid = parent.uid
          }
          if (patch.tags !== undefined) creation.tags = stringList(patch.tags, 'tags')
        }
        const target = request.operation === 'task_update' ? this.task(tasks, args.uid ?? args.objectRef) : undefined
        const before = target ? await this.options.taskService.get(target.uid) : undefined
        if (target && !before) return fail(404, 'task_not_found')
        let task: TaskFact
        try {
          task = request.operation === 'task_create' ? await this.options.taskService.createTask({ ...input, ...creation, title: str(input.title, 'title') }) : await this.options.taskService.updateTask(before!.uid, input)
        } catch (error) {
          const code = (error as Error).message
          if (['read_only_source', 'task_not_found', 'provider_not_found', 'no_writable_provider', 'title_required'].includes(code)) return fail(code === 'read_only_source' ? 403 : 400, code, code === 'read_only_source' ? 'Use Task Pilot to write this read-only source' : code)
          return fail(503, 'task_write_failed', 'TaskService failed; no successful task update is claimed')
        }
        const result: { task: TaskFact; taskWritten: boolean; eventRecorded: boolean; event?: SupervisorEvent; warnings: string[] } = { task, taskWritten: true, eventRecorded: false, warnings: ['Task write succeeded; archive audit was not persisted and needs reconciliation'] }
        archive.requests[requestId] = { state: 'done', payloadHash: hash, result }
        try { await commit() }
        catch { return result }
        const event = this.append(archive, { objectSnapshot: this.objectSnapshot(task, tasks), sourceKind: undefined, objectRef: task.uid, title: request.operation === 'task_create' ? 'Local task created' : 'Local task updated', type: request.operation, description: JSON.stringify({ before: before ?? null, after: task, actor: context.actor }), occurredAt: now(), participants: [], attachmentIds: [], interval: undefined, originalReply: undefined, nextStep: undefined, stage: undefined, waitingFor: undefined }, requestId, hash, context)
        result.event = event
        result.eventRecorded = true
        result.warnings = []
        try { await commit() }
        catch {
          archive.events = archive.events.filter(e => e.id !== event.id)
          delete result.event
          result.eventRecorded = false
          result.warnings = ['Task write succeeded; archive audit was not persisted and needs reconciliation']
        }
        return result
      }
      if (request.operation === 'action') {
        const old = args.id === undefined ? undefined : archive.actions.find(a => a.id === validateId(args.id))
        if (args.id !== undefined && !old) return fail(404, 'action_not_found')
        if (old?.objectRef) this.selectEvents(tasks, old.objectRef, true, this.visible(archive, tasks).events)
        if (old) expected(args.expectedVersion, archive.actionVersions[old.id])
        const fields = { ...old, ...patch }
        const state = fields.state ?? 'suggested'
        if (!['suggested', 'open', 'done', 'dismissed'].includes(String(state))) return fail(400, 'invalid_action_state')
        if (state === 'done' && !context.userInitiated) return fail(403, 'user_request_required', 'A real user request is required; agent suggestions do not authorize state writes')
        const objectRef = fields.objectRef === undefined ? undefined : str(fields.objectRef, 'objectRef')
        if (objectRef) this.selectEvents(tasks, objectRef, true, this.visible(archive, tasks).events)
        const sourceRefs = this.sourceRefs(fields.sourceRefs, archive, tasks)
        const at = now()
        const action: SupervisorAction = { id: old?.id ?? randomUUID(), objectRef, title: str(fields.title, 'title'), reason: str(fields.reason ?? '', 'reason', false), state: state as SupervisorAction['state'], sourceRefs, createdAt: old?.createdAt ?? at, updatedAt: at }
        if (old) {
          archive.actionRevisions[old.id].push({ version: archive.actionVersions[old.id], at, actor: context.actor, previous: { ...old } })
          Object.assign(old, action)
          archive.actionVersions[old.id] += 1
        } else {
          archive.actions.push(action)
          archive.actionVersions[action.id] = 1
          archive.actionRevisions[action.id] = []
        }
        return { ...action, version: archive.actionVersions[action.id] }
      }
      const objectRef = args.objectRef === undefined ? undefined : str(args.objectRef, 'objectRef')
      if (objectRef) this.selectEvents(tasks, objectRef, true, this.visible(archive, tasks).events)
      const kind = args.kind ?? 'summary'
      if (!['summary', 'review', 'retrospective'].includes(String(kind))) return fail(400, 'invalid_report_kind')
      const sourceRefs = this.sourceRefs(args.sourceRefs, archive, tasks)
      const inputVersions = Object.fromEntries(sourceRefs.filter(ref => archive.events.some(e => e.id === ref)).map(ref => [ref, archive.events.find(e => e.id === ref)!.version]))
      if (args.inputVersions !== undefined && payloadHash(record(args.inputVersions)) !== payloadHash(inputVersions)) return fail(409, 'version_conflict', 'Report source versions changed')
      const report: SupervisorReport = { id: randomUUID(), kind: kind as SupervisorReport['kind'], objectRef, content: str(args.content, 'content'), sourceRefs, coverage: str(args.coverage, 'coverage'), missing: stringList(args.missing, 'missing'), createdAt: now(), inputVersions }
      archive.reports.push(report)
      return report
    })
  }
}
