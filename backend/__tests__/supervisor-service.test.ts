import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskFact, TasksConfig } from '../../shared/src/tasks.js'
import type { SupervisorAction, SupervisorAnalysis, SupervisorConfig, SupervisorContext, SupervisorEvent, SupervisorEventList, SupervisorEventSummary, SupervisorReport, SupervisorSession } from '../../shared/src/supervisor.js'
import { SupervisorStore } from '../supervisor/store.js'
import { SupervisorService } from '../supervisor/service.js'
import { TaskService } from '../tasks/service.js'
import { LocalTaskProvider } from '../tasks/providers/local.js'
import { PlanningStore } from '../tasks/planning-store.js'
import { HistoryStore } from '../tasks/history-store.js'
import type { TaskProvider } from '../tasks/types.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const user: SupervisorContext = { actor: 'user', userInitiated: true }
const agent: SupervisorContext = { actor: 'supervisor', userInitiated: false, sessionId: 'main' }
const taskConfig: TasksConfig = { enabled: true, journal: { enabled: false, roots: [], autoDetect: false }, lanes: [], defaultView: 'execute' }
function fact(id: string, parentUid?: string): TaskFact {
  return { uid: `journal:${id}`, providerId: 'journal', id, kind: parentUid ? 'task' : 'epic', parentUid, title: id, completion: 'doing', archived: false, plannable: true, writable: false, sourceLabel: 'Journal', tags: [] }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-service-'))
  roots.push(root)
  const local = new LocalTaskProvider(join(root, 'local.json'))
  const localTask = await local.createTask({ title: 'Local' })
  const journalTasks = [fact('epic'), fact('child', 'journal:epic'), fact('unrelated')]
  const journal: TaskProvider = { id: 'journal', label: 'Journal', type: 'task-journal', capabilities: { writable: false, providesTodos: false, providesProgress: false }, available: async () => true, list: async () => journalTasks }
  const taskService = new TaskService({ getConfig: () => taskConfig, listLiveSessions: () => [], planningStore: new PlanningStore(join(root, 'planning.json')), historyStore: new HistoryStore(join(root, 'history.json')) })
  vi.spyOn(taskService as unknown as { buildProviders(): TaskProvider[] }, 'buildProviders').mockReturnValue([journal, local])
  const config: SupervisorConfig = { enabled: true, cwd: root, pollIntervalMs: 1000, staleAfterMs: 1000, allowedObjects: ['*'], allowedSessionIds: ['*'], allowedRoots: [], agentResources: { rolePath: '', skillPaths: [], extensionPaths: [], allowedTools: [], mode: 'observe' } }
  const store = new SupervisorStore(join(root, 'archive'))
  const service = new SupervisorService({ store, taskService, getConfig: () => config, listSessions: () => [] })
  let request = 0
  const event = async (objectRef = localTask.uid, extra: Record<string, unknown> = {}, context = user) => service.execute({ operation: 'record', args: { requestId: `r${++request}`, objectRef, title: 'Event', type: 'progress', description: 'User says progress', ...extra } }, context) as Promise<SupervisorEvent>
  return { root, local, localTask, journalTasks, taskService, config, store, service, event }
}

describe('SupervisorService', () => {
  it('lists events through a constant-shaped query with real paging, ordering and filters', async () => {
    const f = await fixture()
    const first = await f.event('journal:child', { occurredAt: '2026-01-02T09:00:00Z', title: 'A' })
    const second = await f.event('journal:child', { occurredAt: '2026-02-02T09:00:00Z', type: 'blocked', title: 'B' })
    const undated = await f.event('journal:child', { title: 'C' })

    const recent = await f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', limit: 2 } }, agent) as SupervisorEventList
    expect(recent).toMatchObject({ total: 3, truncated: true, excludedWithoutTime: 0 })
    expect(recent.events.map(event => event.id)).toEqual([second.id, first.id])
    expect(recent.events[0]).not.toHaveProperty('description')
    expect(recent.events[0]).not.toHaveProperty('revisions')
    expect(recent.events[0]).not.toHaveProperty('originalReply')
    expect(recent.events[0]).not.toHaveProperty('payloadHash')

    // Unknown occurrence times stay last in both directions.
    const ascending = await f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', order: 'asc', limit: 10 } }, agent) as SupervisorEventList
    expect(ascending.events.map(event => event.id)).toEqual([first.id, second.id, undated.id])
    expect(ascending).toMatchObject({ total: 3, truncated: false })

    const filtered = await f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', types: ['blocked'] } }, agent) as SupervisorEventList
    expect(filtered.events.map(event => event.id)).toEqual([second.id])
    expect(filtered.total).toBe(1)
    await expect(f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', types: ['interview'] } }, agent)).rejects.toMatchObject({ code: 'invalid_event_type' })

    const ranged = await f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', since: '2026-01-01', until: '2026-01-31' } }, agent) as SupervisorEventList
    expect(ranged.events.map(event => event.id)).toEqual([first.id])
    expect(ranged).toMatchObject({ excludedWithoutTime: 1 })
    await expect(f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', since: '2026-03-01', until: '2026-01-01' } }, agent)).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', since: '2026-13-01' } }, agent)).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', limit: 201 } }, agent)).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', order: 'newest' } }, agent)).rejects.toMatchObject({ code: 'invalid_arguments' })

    const full = await f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', view: 'full', limit: 1 } }, agent) as SupervisorEventList
    expect(full.events[0]).toHaveProperty('description')

    // System types stay queryable even though they are not in the configured vocabulary.
    const state = await f.service.execute({ operation: 'working_state', args: { requestId: 'ws-query', objectRef: 'journal:child', description: '等待联调', stage: '等待' } }, user) as { event: SupervisorEvent; workingState: { sourceEventId: string } }
    const system = await f.service.execute({ operation: 'query', args: { objectRef: 'journal:child', types: ['working_state'] } }, agent) as SupervisorEventList
    expect(system.events.map(event => event.id)).toEqual([state.event.id])
  })

  it('context returns summarized, truncated events instead of the whole archive', async () => {
    const f = await fixture()
    for (let index = 0; index < 3; index += 1) await f.event('journal:child', { occurredAt: `2026-01-0${index + 1}T09:00:00Z` })
    const result = await f.service.execute({ operation: 'context', args: { objectRef: 'journal:child', limit: 2 } }, agent) as { events: SupervisorEventSummary[]; eventsTotal: number; eventsTruncated: boolean }
    expect(result).toMatchObject({ eventsTotal: 3, eventsTruncated: true })
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).not.toHaveProperty('description')
    expect(result.events[0].occurredAt).toBe('2026-01-03T09:00:00Z')
    const defaults = await f.service.execute({ operation: 'context', args: { objectRef: 'journal:child' } }, agent) as { events: SupervisorEventSummary[]; eventsTotal: number; eventsTruncated: boolean }
    expect(defaults).toMatchObject({ eventsTotal: 3, eventsTruncated: false })
  })

  it('rejects event categories outside the vocabulary and keeps system or unchanged types valid', async () => {
    const f = await fixture()
    await expect(f.event('journal:child', { type: 'interview' })).rejects.toMatchObject({ code: 'invalid_event_type' })
    expect((await f.event('journal:child', { type: 'blocked' })).type).toBe('blocked')
    const suggestion = await f.event('journal:child', { type: 'suggestion' }, { actor: '主 Agent', sessionId: 'session-1', userInitiated: false })
    expect(suggestion.type).toBe('suggestion')
    // A stored type outside a later-narrowed vocabulary stays correctable without silently rewriting the category.
    const legacy = await f.event('journal:child')
    f.config.eventTypes = ['interview', 'review']
    const corrected = await f.service.execute({ operation: 'correct', args: { requestId: 'c-1', id: legacy.id, expectedVersion: legacy.version, patch: { title: '改名' } } }, user) as SupervisorEvent
    expect(corrected.title).toBe('改名')
    expect(corrected.type).toBe('progress')
    await expect(f.service.execute({ operation: 'correct', args: { requestId: 'c-2', id: legacy.id, expectedVersion: corrected.version, patch: { type: 'meeting' } } }, user)).rejects.toMatchObject({ code: 'invalid_event_type' })
    expect((await f.event('journal:child', { type: 'interview' })).type).toBe('interview')
    await expect(f.event('journal:child', { type: 'progress' })).rejects.toMatchObject({ code: 'invalid_event_type' })
  })

  it('reads historical screenshot bytes only through a visible event, including archived sources', async () => {
    const f = await fixture()
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const image = await f.store.uploadImage({ name: 'reply.png', mime: 'image/png', data: bytes })
    const saved = await f.event('journal:child', { attachmentIds: [image.id] })
    expect(await f.service.execute({ operation: 'events', args: { id: saved.id } }, user)).toEqual(saved)
    f.journalTasks.splice(1, 1)
    const result = await f.service.execute({ operation: 'events', args: { id: saved.id, includeImages: true } }, user) as { event: SupervisorEvent; images: unknown[] }
    expect(result.event.id).toBe(saved.id)
    expect(result.images).toEqual([{ attachmentId: image.id, mimeType: 'image/png', data: bytes.toString('base64') }])
    await expect(f.service.execute({ operation: 'events', args: { id: saved.id, includeImages: 'yes' } }, user)).rejects.toMatchObject({ code: 'invalid_arguments' })
    f.config.allowedObjects = ['journal:unrelated']
    await expect(f.service.execute({ operation: 'events', args: { id: saved.id, includeImages: true } }, user)).rejects.toMatchObject({ code: 'event_not_found' })
  })
  it('maintains user-confirmed observation state without rewriting read-only provider facts or ordinary records', async () => {
    const f = await fixture()
    await f.event('journal:child', { stage: '说明中的阶段' })
    expect((await f.service.stateData()).workingStates).toEqual({})
    const update = vi.spyOn(f.taskService, 'updateTask')
    const first = await f.service.execute({ operation: 'working_state', args: { requestId: 'ws-1', objectRef: 'journal:child', description: '后端说等待反馈', sourceKind: 'relay', stage: '等待联调', nextStep: '对齐接口', waitingFor: '后端' } }, user) as { event: SupervisorEvent; workingState: { sourceEventId: string; version: number } }
    expect(first).toMatchObject({ sourceTaskUnchanged: true, workingState: { stage: '等待联调', sourceKind: 'relay' } })
    expect(update).not.toHaveBeenCalled()
    await expect(f.service.execute({ operation: 'working_state', args: { requestId: 'ws-2', objectRef: 'journal:child', description: '更新', stage: '联调中' } }, user)).rejects.toMatchObject({ code: 'stale_version' })
    await f.service.execute({ operation: 'working_state', args: { requestId: 'ws-3', objectRef: 'journal:child', description: '已开始联调', stage: '联调中', expectedEventId: first.event.id, expectedVersion: 1 } }, user)
    expect((await f.service.stateData()).workingStates['journal:child']).toMatchObject({ stage: '联调中', nextStep: '对齐接口', waitingFor: '后端' })
    await expect(f.event('journal:child', { type: 'working_state' })).rejects.toMatchObject({ code: 'dedicated_operation_required' })
  })
  it('retains authorized project history, analysis, corrections and reports after sources disappear', async () => {
    const f = await fixture(); f.config.allowedObjects = ['journal:epic']
    const e = await f.event('journal:child')
    f.journalTasks.splice(0)
    expect((await f.service.stateData()).archivedObjectRefs).toContain('journal:epic')
    const args = { objectRef: 'journal:epic', includeChildren: true }
    expect(await f.service.execute({ operation: 'events', args }, agent)).toHaveLength(1)
    expect(await f.service.execute({ operation: 'context', args }, agent)).toMatchObject({ events: [{ id: e.id }] })
    expect(await f.service.execute({ operation: 'analyze', args }, agent)).toMatchObject({ actualEffortMinutes: null })
    const changed = await f.service.execute({ operation: 'correct', args: { requestId: 'history-fix', id: e.id, expectedVersion: 1, patch: { occurredAt: '2026-01-02' } } }, user) as SupervisorEvent
    expect(changed.version).toBe(2)
    await f.service.execute({ operation: 'report', args: { requestId: 'history-report', kind: 'retrospective', objectRef: 'journal:epic', sourceRefs: [e.id], content: '已归档子任务', coverage: '仅授权历史事件，来源当前不可用', missing: ['来源不可用'] } }, agent)
    expect((await f.service.stateData()).reports).toHaveLength(1)
  })
  it('empty scopes deny access and creation rather than implicitly granting all tasks', async () => {
    const f = await fixture(); await f.event()
    f.config.allowedObjects = []; f.config.allowedSessionIds = []
    expect((await f.service.stateData()).tasks.tasks).toEqual([])
    expect((await f.service.stateData()).events).toEqual([])
    await expect(f.service.execute({ operation: 'task_create', args: { requestId: 'empty-create', title: 'Not allowed' } }, user)).rejects.toMatchObject({ code: 'create_outside_scope' })
  })
  it('records user events without task writes, preserving unknown occurrence and source', async () => {
    const { service, store, taskService, localTask, event } = await fixture()
    const update = vi.spyOn(taskService, 'updateTask')
    const create = vi.spyOn(taskService, 'createTask')
    const e = await event()
    expect(e).toMatchObject({ objectRef: localTask.uid, occurredAt: null, version: 1, source: { kind: 'user' } })
    expect(update).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect((await service.stateData()).events).toEqual((await store.snapshot()).events)
  })

  it('records existing image IDs but rejects arbitrary IDs, paths, count and total bytes', async () => {
    const { store, event } = await fixture()
    const image = await store.uploadImage({ name: 'a.png', mime: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) })
    expect((await event(undefined, { attachmentIds: [image.id] })).attachmentIds).toEqual([image.id])
    await expect(event(undefined, { attachmentIds: ['unknown'] })).rejects.toMatchObject({ code: 'invalid_attachment' })
    await expect(event(undefined, { attachmentIds: ['../secret'] })).rejects.toMatchObject({ code: 'invalid_id' })
    await expect(event(undefined, { attachmentIds: ['1', '2', '3', '4', '5'] })).rejects.toMatchObject({ code: 'too_many_attachments' })
    const data = Buffer.alloc(3 * 1024 * 1024)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
    const ids = await Promise.all([1, 2, 3].map(async n => (await store.uploadImage({ name: `${n}.png`, mime: 'image/png', data })).id))
    await expect(event(undefined, { attachmentIds: ids })).rejects.toMatchObject({ status: 413 })
  })

  it('replays records and corrections; hashes payload and preserves prior revisions', async () => {
    const { service, store, event } = await fixture()
    const e = await event(undefined, { requestId: 'first' })
    const correction = { operation: 'correct' as const, args: { id: e.id, requestId: 'fix', expectedVersion: 1, patch: { description: 'Corrected', occurredAt: '2026-04-01T09:15:00Z' } } }
    const corrected = await service.execute(correction, user) as SupervisorEvent
    expect(corrected.version).toBe(2)
    expect(corrected.revisions[0]).toMatchObject({ version: 1, actor: 'user', previous: { description: 'User says progress', occurredAt: null } })
    expect(await service.execute(correction, user)).toEqual(corrected)
    await expect(service.execute({ ...correction, args: { ...correction.args, patch: { description: 'different' } } }, user)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(service.execute({ ...correction, args: { ...correction.args, requestId: 'stale' } }, user)).rejects.toMatchObject({ code: 'version_conflict', status: 409 })
    expect((await store.snapshot()).events).toHaveLength(1)
    expect((await store.snapshot()).events[0].revisions).toHaveLength(1)
  })

  it('rejects invalid calendar times and cross-object explicit links', async () => {
    const { event } = await fixture()
    await expect(event(undefined, { occurredAt: '2026-02-30' })).rejects.toMatchObject({ code: 'invalid_time' })
    await expect(event(undefined, { occurredAt: '2026-04-01T09:00:00' })).rejects.toMatchObject({ code: 'invalid_time' })
    const e = await event('journal:child')
    await expect(event(undefined, { interval: { kind: 'wait', startEventId: e.id } })).rejects.toMatchObject({ code: 'invalid_interval_link' })
  })

  it('uses actual local TaskService create/update, appends audit history and never repeats creation', async () => {
    const { service, local, store, taskService } = await fixture()
    const create = vi.spyOn(taskService, 'createTask')
    const request = { operation: 'task_create' as const, args: { requestId: 'create', title: 'Follow-up', description: 'Real local task' } }
    const results = await Promise.all([service.execute(request, user), service.execute(request, user)]) as Array<{ task: TaskFact; taskWritten: boolean; eventRecorded: boolean }>
    expect(results[0]).toMatchObject({ taskWritten: true, eventRecorded: true })
    expect(results[1]).toEqual(results[0])
    expect(create).toHaveBeenCalledTimes(1)
    expect((await local.list()).filter(t => t.title === 'Follow-up')).toHaveLength(1)
    const uid = results[0].task.uid
    await service.execute({ operation: 'task_update', args: { requestId: 'update', uid, patch: { status: 'doing', title: 'Updated' } } }, user)
    expect((await local.list()).find(t => t.uid === uid)).toMatchObject({ title: 'Updated', completion: 'doing' })
    const events = (await store.snapshot()).events
    expect(events.map(e => e.type)).toEqual(['task_create', 'task_update'])
    expect(JSON.parse(events[1].description).before.title).toBe('Follow-up')
    expect(JSON.parse(events[1].description).after.title).toBe('Updated')
  })

  it('rejects read-only journal writes with Task Pilot explanation', async () => {
    const { service, taskService } = await fixture()
    const update = vi.spyOn(taskService, 'updateTask')
    await expect(service.execute({ operation: 'task_update', args: { requestId: 'write', uid: 'journal:child', status: 'doing' } }, user)).rejects.toMatchObject({ code: 'read_only_source', status: 403, message: expect.stringContaining('Task Pilot') })
    expect(update).not.toHaveBeenCalled()
  })

  it('requires real user initiation and ignores args.confirmed', async () => {
    const { service, localTask, event } = await fixture()
    for (const operation of ['task_create', 'task_update', 'correct'] as const) await expect(service.execute({ operation, args: { requestId: operation, uid: localTask.uid, title: 'Agent' } }, agent)).rejects.toMatchObject({ code: 'user_request_required' })
    await expect(event(undefined, {}, agent)).rejects.toMatchObject({ code: 'user_request_required' })
    expect((await event(undefined, { type: 'suggestion' }, agent)).source.kind).toBe('agent')
    // Completion is a real user turn's call; a client-sent confirmed flag is not part of the protocol any more.
    const request = { operation: 'task_update' as const, args: { requestId: 'done', uid: localTask.uid, status: 'done' } }
    await expect(service.execute(request, agent)).rejects.toMatchObject({ code: 'user_request_required' })
    const result = await service.execute(request, user) as { task: TaskFact }
    expect(result.task.completion).toBe('done')
  })

  it('allows agent suggestions/reports but user-gates action transitions and versions', async () => {
    const { service, store, localTask, event } = await fixture()
    const e = await event()
    const action = await service.execute({ operation: 'action', args: { requestId: 'suggest', objectRef: localTask.uid, title: 'Ask colleague', reason: 'Blocked', sourceRefs: [e.id] } }, agent) as SupervisorAction & { version: number }
    expect(action).toMatchObject({ state: 'suggested', version: 1 })
    await expect(service.execute({ operation: 'action', args: { requestId: 'auto-open', id: action.id, expectedVersion: 1, state: 'open' } }, agent)).rejects.toMatchObject({ code: 'user_request_required' })
    const opened = await service.execute({ operation: 'action', args: { requestId: 'open', id: action.id, expectedVersion: 1, state: 'open' } }, user) as SupervisorAction & { version: number }
    expect(opened.version).toBe(2)
    await expect(service.execute({ operation: 'action', args: { requestId: 'finish', id: action.id, expectedVersion: 2, state: 'done' } }, agent)).rejects.toMatchObject({ code: 'user_request_required' })
    await service.execute({ operation: 'action', args: { requestId: 'finish', id: action.id, expectedVersion: 2, state: 'done' } }, user)
    expect((await store.snapshot()).actionRevisions[action.id]).toHaveLength(2)
    const report = await service.execute({ operation: 'report', args: { requestId: 'report', objectRef: localTask.uid, content: 'Observed waiting', coverage: 'One recorded event', missing: ['No effort'], sourceRefs: [e.id] } }, agent) as SupervisorReport
    expect(report.inputVersions).toEqual({ [e.id]: 1 })
    expect(report.missing).toEqual(['No effort'])
    await expect(service.execute({ operation: 'report', args: { requestId: 'unknown-source', content: 'Bad', coverage: 'None', sourceRefs: ['unknown'] } }, agent)).rejects.toMatchObject({ code: 'invalid_source_ref' })
  })

  it('wildcard scopes deduplicate UIDs and aggregate epic children without unrelated tasks', async () => {
    const { service, config, journalTasks, event } = await fixture()
    await event('journal:epic')
    await event('journal:child')
    await event('journal:unrelated')
    journalTasks.push({ ...journalTasks[1] })
    config.allowedObjects = ['journal:epi*']
    const state = await service.stateData()
    expect(state.tasks.tasks.map(t => t.uid)).toEqual(['journal:epic', 'journal:child'])
    expect(state.events).toHaveLength(2)
    expect(await service.execute({ operation: 'events', args: { objectRef: 'journal:epic' } }, agent)).toHaveLength(2)
    expect(await service.execute({ operation: 'events', args: { objectRef: 'journal:epic', includeChildren: false } }, agent)).toHaveLength(1)
    await expect(event('journal:unrelated')).rejects.toMatchObject({ code: 'object_not_allowed' })
    await expect(service.execute({ operation: 'task_create', args: { requestId: 'out', title: 'Out of scope' } }, user)).rejects.toMatchObject({ code: 'create_outside_scope' })
  })

  it('authorizes wildcard-covered generated local IDs before creation but rejects narrower ID prefixes', async () => {
    const { service, config } = await fixture()
    config.allowedObjects = ['lo*:t-*']
    expect(await service.execute({ operation: 'task_create', args: { requestId: 'wildcard-local', title: 'Allowed local' } }, user)).toMatchObject({ taskWritten: true, task: { providerId: 'local' } })
    config.allowedObjects = ['local:t-a*']
    await expect(service.execute({ operation: 'task_create', args: { requestId: 'narrow-local', title: 'Cannot guarantee allowed ID' } }, user)).rejects.toMatchObject({ code: 'create_outside_scope' })
  })

  it('rejects ambiguous UID identities and retains unavailable historical records with warnings', async () => {
    const { service, journalTasks, event, store } = await fixture()
    await event('journal:child')
    journalTasks.push({ ...journalTasks[1], title: 'Different identity' })
    const state = await service.stateData()
    expect(state.tasks.tasks.some(t => t.uid === 'journal:child')).toBe(false)
    expect(state.warnings.join(' ')).toContain('Conflicting task UID')
    expect(state.events).toHaveLength(1)
    expect((await store.snapshot()).events).toHaveLength(1)
  })

  it('revalidates correction scope on idempotent replay instead of leaking prior data', async () => {
    const { event, service, config } = await fixture()
    const e = await event('journal:unrelated')
    const request = { operation: 'correct' as const, args: { id: e.id, requestId: 'fix', expectedVersion: 1, description: 'Fixed' } }
    await service.execute(request, user)
    config.allowedObjects = ['journal:epic']
    await expect(service.execute(request, user)).rejects.toMatchObject({ code: 'outside_scope' })
  })

  it('analyzes only linked precise intervals, keeps overlapping waits separate and never infers effort', async () => {
    const { event, service, localTask } = await fixture()
    const a = await event(undefined, { occurredAt: '2026-04-01T09:00:00Z' })
    const b = await event(undefined, { occurredAt: '2026-04-01T09:30:00Z' })
    await event(undefined, { occurredAt: '2026-04-01T10:00:00Z', interval: { kind: 'wait', startEventId: a.id } })
    await event(undefined, { occurredAt: '2026-04-01T10:30:00Z', interval: { kind: 'wait', startEventId: b.id } })
    await event(undefined, { occurredAt: '2026-04-01T12:00:00Z' })
    const analysis = await service.execute({ operation: 'analyze', args: { objectRef: localTask.uid } }, agent) as SupervisorAnalysis
    expect(analysis.intervals.map(i => i.minutes)).toEqual([60, 60])
    // No additive wait total: these two explicit overlapping periods are not 120 minutes of waiting.
    expect(analysis).not.toHaveProperty('totalWaitMinutes')
    expect(analysis.actualEffortMinutes).toBeNull()
    expect(analysis.missing).toContain('No explicit actual effort duration recorded')
    await event(undefined, { interval: { kind: 'effort', startEventId: a.id, durationMinutes: 25 } })
    const actual = await service.execute({ operation: 'analyze' }, agent) as SupervisorAnalysis
    expect(actual.actualEffortMinutes).toBe(25)
  })

  it('does not time date-only, unknown or reversed intervals or assume missing effort is zero', async () => {
    const { event, service } = await fixture()
    const date = await event(undefined, { occurredAt: '2026-04-01' })
    const later = await event(undefined, { occurredAt: '2026-04-01T11:00:00Z' })
    await event(undefined, { occurredAt: '2026-04-01', interval: { kind: 'stage', startEventId: date.id } })
    await event(undefined, { interval: { kind: 'wait', startEventId: later.id } })
    await event(undefined, { occurredAt: '2026-04-01T10:00:00Z', interval: { kind: 'wait', startEventId: later.id } })
    await event(undefined, { interval: { kind: 'effort', startEventId: later.id } })
    const analysis = await service.execute({ operation: 'analyze' }, agent) as SupervisorAnalysis
    expect(analysis.intervals).toHaveLength(4)
    expect(analysis.intervals.every(i => i.minutes === null && i.warning)).toBe(true)
    expect(analysis.actualEffortMinutes).toBeNull()
  })

  it('returns truthful partial task success after audit failure and replays without duplicate task', async () => {
    const { service, store, local, taskService } = await fixture()
    const create = vi.spyOn(taskService, 'createTask')
    const target = store as unknown as { atomic(path: string, data: Buffer | string): Promise<void> }
    const original = target.atomic.bind(store)
    let archiveWrites = 0
    vi.spyOn(target, 'atomic').mockImplementation(async (path, data) => {
      if (path.endsWith('archive.json') && ++archiveWrites === 3) throw new Error('audit write fails')
      return original(path, data)
    })
    const request = { operation: 'task_create' as const, args: { requestId: 'partial', title: 'Persisted despite audit failure' } }
    const result = await service.execute(request, user) as { taskWritten: boolean; eventRecorded: boolean; warnings: string[] }
    expect(result).toMatchObject({ taskWritten: true, eventRecorded: false })
    expect(result.warnings.join(' ')).toContain('reconciliation')
    expect(await service.execute(request, user)).toEqual(result)
    expect(create).toHaveBeenCalledTimes(1)
    expect((await local.list()).filter(t => t.title === request.args.title)).toHaveLength(1)
    expect((await store.snapshot()).events).toEqual([])
  })

  it('preserves pending receipt and truthful external outcome if all post-task archive writes fail', async () => {
    const { service, store, taskService } = await fixture()
    const create = vi.spyOn(taskService, 'createTask')
    const target = store as unknown as { atomic(path: string, data: Buffer | string): Promise<void> }
    const original = target.atomic.bind(store)
    let writes = 0
    vi.spyOn(target, 'atomic').mockImplementation(async (path, data) => {
      if (path.endsWith('archive.json') && ++writes >= 2) throw new Error('disk unavailable')
      return original(path, data)
    })
    const request = { operation: 'task_create' as const, args: { requestId: 'pending', title: 'Exactly once' } }
    expect(await service.execute(request, user)).toMatchObject({ taskWritten: true, eventRecorded: false, warnings: [expect.stringContaining('reconcile')] })
    await expect(service.execute(request, user)).rejects.toMatchObject({ code: 'request_pending' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not claim success when TaskService fails', async () => {
    const { service, taskService, store } = await fixture()
    vi.spyOn(taskService, 'createTask').mockRejectedValue(new Error('I/O failure'))
    await expect(service.execute({ operation: 'task_create', args: { requestId: 'fail', title: 'Not persisted' } }, user)).rejects.toMatchObject({ code: 'task_write_failed', status: 503 })
    expect((await store.snapshot()).events).toEqual([])
  })

  it('uses the latest actual task for serialized concurrent update audit history', async () => {
    const { service, localTask, store } = await fixture()
    await Promise.all([
      service.execute({ operation: 'task_update', args: { requestId: 'first-update', uid: localTask.uid, status: 'doing' } }, user),
      service.execute({ operation: 'task_update', args: { requestId: 'second-update', uid: localTask.uid, title: 'Second' } }, user),
    ])
    const events = (await store.snapshot()).events
    const first = JSON.parse(events[0].description)
    const second = JSON.parse(events[1].description)
    expect(second.before).toEqual(first.after)
  })

  it('flags reports as stale after event correction without rewriting the old report', async () => {
    const { service, store, event } = await fixture()
    const e = await event()
    const report = await service.execute({ operation: 'report', args: { requestId: 'versioned-report', content: 'Original conclusion', coverage: 'One event', sourceRefs: [e.id] } }, agent) as SupervisorReport
    await service.execute({ operation: 'correct', args: { requestId: 'new-version', id: e.id, expectedVersion: 1, description: 'New facts' } }, user)
    expect((await service.stateData()).warnings.join(' ')).toContain(`Report ${report.id} has changed or newly recorded source data`)
    expect((await store.snapshot()).reports[0]).toEqual(report)
  })

  it('does not admit agent interval suggestions into actual effort statistics', async () => {
    const { event, service } = await fixture()
    const start = await event()
    await expect(event(undefined, { type: 'suggestion', interval: { kind: 'effort', startEventId: start.id, durationMinutes: 120 } }, agent)).rejects.toMatchObject({ code: 'user_request_required' })
    const suggestion = await event(undefined, { type: 'suggestion', occurredAt: '2026-04-01T09:00:00Z' }, agent)
    await event(undefined, { occurredAt: '2026-04-01T10:00:00Z', interval: { kind: 'wait', startEventId: suggestion.id } })
    const analysis = await service.execute({ operation: 'analyze' }, agent) as SupervisorAnalysis
    expect(analysis.intervals[0]).toMatchObject({ minutes: null, warning: expect.stringContaining('not confirmed facts') })
    expect(analysis.actualEffortMinutes).toBeNull()
  })

  it('orders events by actual occurrence across timezones and puts unknown time last', async () => {
    const { event, service } = await fixture()
    const later = await event(undefined, { occurredAt: '2026-04-01T09:00:00Z' })
    const earlier = await event(undefined, { occurredAt: '2026-04-01T10:00:00+02:00' })
    const unknown = await event()
    const events = await service.execute({ operation: 'events' }, agent) as SupervisorEvent[]
    expect(events.map(e => e.id)).toEqual([earlier.id, later.id, unknown.id])
  })

  it('filters session allowlist for context and leaves runtime operations to main', async () => {
    const { config, store, taskService } = await fixture()
    config.allowedSessionIds = ['safe-*']
    const service = new SupervisorService({ store, taskService, getConfig: () => config, listSessions: () => [{ sessionId: 'safe-1' }, { sessionId: 'private' }] as SupervisorSession[] })
    expect(await service.execute({ operation: 'context' }, agent)).toMatchObject({ sessions: [{ sessionId: 'safe-1' }] })
    await expect(service.execute({ operation: 'inspect' }, agent)).rejects.toMatchObject({ code: 'unsupported_operation' })
    config.enabled = false
    await expect(service.execute({ operation: 'context' }, agent)).rejects.toMatchObject({ code: 'supervisor_disabled' })
  })
})
