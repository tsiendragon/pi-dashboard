import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import supervisorExtension from '../../../pi-tsien-extension/extensions/supervisor/index.js'
import { SupervisorStore } from '../supervisor/store.js'
import { SupervisorService } from '../supervisor/service.js'
import { SupervisorRuntime } from '../supervisor/runtime.js'
import { normalizeSupervisorConfig } from '../supervisor/config.js'
import { LocalTaskProvider } from '../tasks/providers/local.js'
import type { TaskService } from '../tasks/service.js'
import { DEFAULT_LIVE_SESSION_CONFIG } from '../live-sessions/config.js'
import type { LiveSessionRegistry } from '../live-sessions/registry.js'
import type { LiveSessionDetail } from '../../shared/src/live-sessions.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
it('real extension tools create/update local tasks, record evidence and retain history through the authenticated gateway', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supervisor-e2e-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const skills = path.join(root, 'skills'); await mkdir(skills)
  await writeFile(path.join(skills, 'SKILL.md'), '---\nname: supervisor\ndescription: integration test\n---\nInspect')
  const role = path.join(root, 'role.md'), ext = path.join(root, 'extension.ts'); await writeFile(role, '# Supervisor'); await writeFile(ext, 'export default function(){}')
  const config = normalizeSupervisorConfig({ enabled: true, cwd: root, allowedObjects: ['*'], allowedSessionIds: ['*'], agentResources: { rolePath: role, skillPaths: [skills], extensionPaths: [ext], allowedTools: normalizeSupervisorConfig({}).agentResources.allowedTools, mode: 'observe' } })
  const provider = new LocalTaskProvider(path.join(root, 'tasks.json'))
  const localTasks = {
    snapshot: async () => ({ tasks: await provider.list(), providers: [{ id: 'local', type: 'local', label: 'Local', available: true, capabilities: provider.capabilities }], warnings: [], planning: {}, sessionRefs: {}, lanes: [], defaultView: 'execute', counts: {} }),
    createTask: (input: Parameters<LocalTaskProvider['createTask']>[0]) => provider.createTask(input),
    get: (uid: string) => provider.get(uid.slice('local:'.length)),
    updateTask: async (uid: string, patch: Parameters<LocalTaskProvider['updateTask']>[1]) => { const result = await provider.updateTask(uid.slice('local:'.length), patch); if (!result) throw new Error('task_not_found'); return result },
  } as unknown as TaskService
  const detail = { summary: { sessionId: 'supervisor-main', processInstanceId: 'process-main', status: 'idle', claim: { state: 'unclaimed' }, lastActivityAt: Date.now() }, entries: [], pendingUi: [] } as unknown as LiveSessionDetail
  const send = vi.fn(async () => ({}))
  const registry = { list: () => [detail.summary], get: () => detail, claim: async () => ({ leaseId: 'lease' }), release: async () => ({}), sendBrowserCommand: send } as unknown as LiveSessionRegistry
  const store = new SupervisorStore(path.join(root, 'private'))
  const service = new SupervisorService({ store, taskService: localTasks, getConfig: () => config, listSessions: () => [] })
  const runtime = new SupervisorRuntime({ root: path.join(root, 'private'), service, registry, getConfig: () => config, liveConfig: DEFAULT_LIVE_SESSION_CONFIG, launch: async () => ({ processInstanceId: 'process-main', sessionId: 'supervisor-main' }) }); cleanup.push(() => runtime.close()); await runtime.boot(); await runtime.start()
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{content:Array<{text:string}>}> }>()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const api = { registerFlag: vi.fn(), getFlag: () => path.join(root, 'private/credentials.json'), registerTool: (t: {name:string;execute:(...args:unknown[])=>Promise<{content:Array<{text:string}>}>}) => tools.set(t.name,t), on: (name:string, handler:(...args:unknown[])=>unknown) => handlers.set(name,handler), getAllTools: () => [...tools.keys()].map(name => ({name})), setActiveTools: vi.fn() } as unknown as ExtensionAPI
  supervisorExtension(api)
  const context = { sessionManager: { getSessionId: () => 'supervisor-main' }, hasUI: true, ui: { confirm: vi.fn(async () => true) } }
  await handlers.get('session_start')!({}, context)
  let sequence = 0
  async function tool(name: string, args: Record<string,unknown>) { const result = await tools.get(name)!.execute('call-'+(++sequence),args,new AbortController().signal,undefined,context); return JSON.parse(result.content[0].text).result }
  async function user(text: string) {
    await runtime.input(text)
    const command = send.mock.calls.at(-1) as unknown as [string,string,{text:string}]
    await handlers.get('before_agent_start')!({prompt:command[2].text})
  }
  await expect(tool('supervisor_task_create',{title:'No user grant'})).rejects.toThrow()
  await user('创建任务：协作交付 Epic')
  const epic = await tool('supervisor_task_create',{title:'协作交付',kind:'epic'})
  await user('创建任务：接口联调')
  const created = await tool('supervisor_task_create',{title:'接口联调',kind:'task',parentUid:epic.task.uid})
  expect(created.task.parentUid).toBe(epic.task.uid); expect(created.eventRecorded).toBe(true)
  await user('把任务状态改为进行中')
  const updated = await tool('supervisor_task_update',{uid:created.task.uid,status:'doing'})
  expect(updated.task.completion).toBe('doing'); expect(updated.eventRecorded).toBe(true)
  await user('给任务记录后端回复')
  const event = await tool('event_append',{objectRef:created.task.uid,title:'后端回复',type:'reply',description:'用户转述',originalReply:'接口明天完成',sourceKind:'relay',participants:['后端'],occurredAt:null})
  expect(event.source.kind).toBe('relay'); expect(event.source.messageRef).toBeTruthy(); expect(event.recorder).toBe('主 Agent');
  expect(event.originalReply).toBe('接口明天完成'); expect((await provider.get(created.task.id))!.completion).toBe('doing')
  const events = await tool('event_list',{objectRef:epic.task.uid,includeChildren:true})
  expect(events).toHaveLength(4)
  await user('修正那条事件')
  const corrected = await tool('event_correct',{id:event.id,expectedVersion:1,patch:{occurredAt:'2026-10-08T10:00:00+08:00'},reason:'补充发生时间'})
  expect(corrected.version).toBe(2); expect(context.ui.confirm).not.toHaveBeenCalled()
  await user('把任务状态改为已完成')
  await tool('supervisor_task_update',{uid:created.task.uid,status:'done',evidence:'用户已完成联调验收'})
  expect((await provider.get(created.task.id))!.completion).toBe('done'); expect(context.ui.confirm).toHaveBeenCalled()
  await user('不要创建任务')
  context.ui.confirm.mockResolvedValueOnce(false)
  await expect(tool('supervisor_task_create', { title: '不能误建' })).rejects.toThrow('cancelled')
  expect(await provider.list()).toHaveLength(2)
  await handlers.get('before_agent_start')!({prompt:'[supervisor-auto-patrol]自动巡查，不是用户新授权'})
  await expect(tool('supervisor_task_update',{uid:created.task.uid,status:'doing'})).rejects.toThrow()
  // Screenshots pasted in the pane are archived through the same store, then referenced by a record.
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 5)]).toString('base64')
  const stored = await service.execute({ operation: 'attachment_put', args: { name: '粘贴截图.png', mime: 'image/png', data: png } }, { actor: '主 Agent', sessionId: 'supervisor-main', userInitiated: true }) as { attachmentId: string; bytes: number }
  expect(stored.bytes).toBe(40)
  const withImage = await service.execute({ operation: 'record', args: { objectRef: created.task.uid, title: '带截图的记录', type: 'progress', description: '截图见附件', occurredAt: null, participants: [], attachmentIds: [stored.attachmentId], requestId: 'req-image-1' } }, { actor: '主 Agent', sessionId: 'supervisor-main', userInitiated: true }) as { id: string; attachmentIds: string[] }
  expect(withImage.attachmentIds).toEqual([stored.attachmentId])
  const read = await service.execute({ operation: 'events', args: { id: withImage.id, includeImages: true } }, { actor: '浏览器', userInitiated: false }) as { images: Array<{ attachmentId: string; mimeType: string }> }
  expect(read.images.map(image => image.attachmentId)).toEqual([stored.attachmentId])
  // A body that is not an image is rejected instead of stored as evidence.
  await expect(service.execute({ operation: 'attachment_put', args: { name: 'x.png', mime: 'image/png', data: Buffer.from('not an image').toString('base64') } }, { actor: '主 Agent', sessionId: 'supervisor-main', userInitiated: true })).rejects.toThrow()
  await expect(service.execute({ operation: 'attachment_put', args: { name: 'x.png', mime: 'image/png', data: 'AAAA' } }, { actor: '主 Agent', sessionId: 'supervisor-main', userInitiated: false })).rejects.toThrow()
  expect((await new SupervisorStore(path.join(root, 'private')).snapshot()).events).toHaveLength(6)
  await provider.deleteTask(created.task.id)
  const retained = await service.execute({ operation: 'events', args: { objectRef: created.task.uid } }, { actor: '浏览器', userInitiated: false })
  expect(retained).toHaveLength(5)
  expect((await service.stateData()).warnings.join(' ')).toContain('history remains readable')
})
