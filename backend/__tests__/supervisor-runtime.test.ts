import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import type { LiveSessionRegistry } from '../live-sessions/registry.js'
import type { LiveSessionDetail } from '../../shared/src/live-sessions.js'
import type { SupervisorService } from '../supervisor/service.js'
import { DEFAULT_LIVE_SESSION_CONFIG } from '../live-sessions/config.js'
import { SUPERVISOR_STANDARD_EVENT_TYPES } from '../../shared/src/supervisor.js'
import { goalExtensionPath } from '../supervisor/config.js'
import { normalizeEventTypes, normalizeSupervisorConfig, validateSupervisorResources } from '../supervisor/config.js'
import { observeSession, processAlive, SupervisorRuntime, userOperations } from '../supervisor/runtime.js'
import { protectSupervisorFiles } from '../routes/supervisor.js'
import type { Request, Response } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'

const roots: string[] = []
const runtimes: SupervisorRuntime[] = []
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
async function fixture(over: { launch?: (args: string[], cwd: string, sessionFile?: string) => Promise<{ processInstanceId: string; sessionId: string }> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supervisor-runtime-')); roots.push(root)
  const skill = path.join(root, 'skill'); await mkdir(skill)
  const role = path.join(root, 'role.md'), extension = path.join(root, 'extension.ts')
  await writeFile(role, '# Role'); await writeFile(path.join(skill, 'SKILL.md'), '---\nname: supervisor\ndescription: Testing supervisor\n---\nRules'); await writeFile(extension, 'export default function() {}')
  const config = normalizeSupervisorConfig({ enabled: true, cwd: root, allowedRoots: [root], allowedObjects: ['*'], allowedSessionIds: ['*'], agentResources: { rolePath: role, skillPaths: [skill], extensionPaths: [extension], allowedTools: ['supervisor_context', 'event_append'], mode: 'observe' } })
  let detail: LiveSessionDetail | undefined
  const summary = { processInstanceId: 'process-main', sessionId: 'session-main', title: 'main', status: 'idle', claim: { state: 'unclaimed' }, lastActivityAt: Date.now(), cwd: root, canonicalCwd: root }
  const registry = { list: vi.fn(() => detail ? [detail.summary] : []), get: vi.fn(() => detail), claim: vi.fn(async () => ({ leaseId: 'lease' })), release: vi.fn(async () => ({})), sendBrowserCommand: vi.fn(async () => ({})) }
  const execute = vi.fn(async () => ({ saved: true }))
  const service = { execute, stateData: vi.fn(async () => ({ tasks: { tasks: [], providers: [], warnings: [] }, events: [], actions: [], reports: [], warnings: [] })) }
  const runtime = new SupervisorRuntime({ root: path.join(root, 'private'), getConfig: () => config, registry: registry as unknown as LiveSessionRegistry, service: service as unknown as SupervisorService, liveConfig: DEFAULT_LIVE_SESSION_CONFIG, launch: over.launch ?? (async () => { detail = { summary, entries: [], pendingUi: [] } as unknown as LiveSessionDetail; return { processInstanceId: 'process-main', sessionId: 'session-main' } }) }); runtimes.push(runtime)
  await runtime.boot()
  return { root, config, registry, service, runtime, getDetail: () => detail }
}
async function rpc(socketPath: string, token: string, url: string, body: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath, path: url, method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) })) }); req.on('error', reject); req.end(JSON.stringify(body))
  })
}

describe('supervisor resource isolation', () => {
  it('disables global discovery and explicitly loads only approved resources', async () => {
    const f = await fixture(); const result = await validateSupervisorResources(f.config)
    expect(result.args).toContain('--no-extensions'); expect(result.args).toContain('--no-skills'); expect(result.args).toContain('--no-context-files'); expect(result.args).toContain('--no-builtin-tools'); expect(result.args).not.toContain('--tools'); expect(result.args).toContain('--skill'); expect(result.args).toContain('--extension'); expect(result.args).toContain('--system-prompt')
    // The launcher script adds --goal-continuation, which only the goal extension registers.
    expect(normalizeSupervisorConfig({}).agentResources.extensionPaths).toContain(goalExtensionPath)
    expect(normalizeSupervisorConfig({}).agentResources.extensionPaths).toHaveLength(3)
    await writeFile(path.join(f.config.agentResources.skillPaths[0], 'SKILL.md'), '---\nname: supervisor\ndescription: Testing\n---\nChanged')
    const afterSkill = await validateSupervisorResources(f.config)
    expect(afterSkill.revision).toBe(result.revision)
    expect(afterSkill.contentRevision).not.toBe(result.contentRevision)
  })
  it('resource isolation keeps instruction text and extension sources out of the gating revision but tracks them separately', async () => {
    const f = await fixture(); const result = await validateSupervisorResources(f.config)
    // Editing role/Skill text or extension code only asks for a restart; the gated revision covers the
    // launch shape (tool allowlist, extension list, mode, name, paths) alone.
    await writeFile(path.join(f.config.agentResources.skillPaths[0], 'SKILL.md'), '---\nname: supervisor\ndescription: Testing\n---\nChanged')
    const afterSkill = await validateSupervisorResources(f.config)
    expect(afterSkill.revision).toBe(result.revision)
    expect(afterSkill.contentRevision).not.toBe(result.contentRevision)
    expect(afterSkill.extensionsRevision).toBe(result.extensionsRevision)
    await writeFile(f.config.agentResources.extensionPaths[0], 'export default function changed() {}')
    const afterExtension = await validateSupervisorResources(f.config)
    expect(afterExtension.revision).toBe(afterSkill.revision)
    expect(afterExtension.extensionsRevision).not.toBe(afterSkill.extensionsRevision)
    await writeFile(f.config.agentResources.extensionPaths[0], 'export default function() {}')
    expect((await validateSupervisorResources(f.config)).extensionsRevision).toBe(result.extensionsRevision)
  })
  it('rejects duplicate paths, missing metadata and built-in shell tools', async () => {
    const f = await fixture(); f.config.agentResources.extensionPaths.push(f.config.agentResources.extensionPaths[0]); await expect(validateSupervisorResources(f.config)).rejects.toThrow('duplicate_resource')
    f.config.agentResources.extensionPaths.pop(); f.config.agentResources.allowedTools.push('bash'); await expect(validateSupervisorResources(f.config)).rejects.toThrow('allowlist')
  })
})
describe('recorded main-session binding', () => {
  it('re-reads runtime.json at every start, so a cleaned-up binding needs no service restart', async () => {
    const seen: Array<string | undefined> = []
    const f = await fixture({ launch: async (_args, _cwd, sessionFile) => { seen.push(sessionFile); return { processInstanceId: 'process-new', sessionId: 'session-new' } } })
    const recordPath = path.join(f.root, 'private', 'runtime.json')
    // A launch with nobody registered keeps whatever file the record held …
    await writeFile(recordPath, JSON.stringify({ loaded: false, sessionFile: '/tmp/wrong-conversation.jsonl', sessionId: 'session-wrong' }))
    await f.runtime.start()
    expect(seen).toEqual(['/tmp/wrong-conversation.jsonl'])
    // … and after the operator clears the wrong binding, the next start must not resume it.
    await writeFile(recordPath, JSON.stringify({ loaded: false }))
    await f.runtime.start()
    expect(seen).toEqual(['/tmp/wrong-conversation.jsonl', undefined])
  })
})
describe('recorded main-session process check', () => {
  it('treats a zombie or recycled pid as ended instead of blocking a new start', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'proc-fake-')); roots.push(root)
    const live = async (pid: number, state: string, cmdline: string) => { await mkdir(path.join(root, String(pid)), { recursive: true }); await writeFile(path.join(root, String(pid), 'stat'), `${pid} (pi) ${state} 1 2 3`); await writeFile(path.join(root, String(pid), 'cmdline'), cmdline) }
    await live(4001, 'S', '~/pi-fork/bin/pi\u0000--no-extensions')
    await live(4002, 'Z', '~/pi-fork/bin/pi\u0000')
    await live(4003, 'S', '/usr/bin/bash\u0000-c\u0000sleep 1')
    expect(await processAlive(4001, root)).toBe(true)
    expect(await processAlive(4002, root)).toBe(false)
    expect(await processAlive(4003, root)).toBe(false)
    expect(await processAlive(4004, root)).toBe(false)
  })
})
describe('supervisor clear', () => {
  it('opens a new main session and persists its binding without writing task data', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.root, 'private', 'credentials.json'), 'utf8'))
    f.registry.sendBrowserCommand.mockImplementationOnce(async () => {
      const detail = f.getDetail()!
      detail.summary.sessionId = 'session-empty'
      detail.summary.processInstanceId = 'process-empty'
      detail.summary.sessionFile = '/sessions/empty.jsonl'
      const loaded = await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools, sessionId: 'session-empty' })
      expect(loaded.status).toBe(200)
      return {}
    })
    const result = await f.runtime.clear()
    expect(result.sessionId).toBe('session-empty')
    expect(result.sessionFile).toBe('/sessions/empty.jsonl')
    expect(f.registry.sendBrowserCommand).toHaveBeenCalledWith('process-main', 'dashboard-supervisor', { type: 'input', text: '/supervisor-clear', images: undefined, channel: 'web' })
    expect(f.service.execute).not.toHaveBeenCalled()
    expect(f.registry.release).toHaveBeenCalled()
  })
  it('does not clear a busy or claimed session', async () => {
    const f = await fixture(); await f.runtime.start()
    f.getDetail()!.summary.status = 'running'
    await expect(f.runtime.clear()).rejects.toThrow('正在工作')
    f.getDetail()!.summary.status = 'idle'
    f.getDetail()!.summary.claim = { state: 'claimed', leaseId: 'human' } as LiveSessionDetail['summary']['claim']
    await expect(f.runtime.clear()).rejects.toThrow('不抢控制权')
    expect(f.registry.sendBrowserCommand).not.toHaveBeenCalled()
  })
  it('requires updated resources before sending the clear command', async () => {
    const f = await fixture(); await f.runtime.start()
    await writeFile(f.config.agentResources.extensionPaths[0], 'export default function updated() {}')
    await expect(f.runtime.clear()).rejects.toThrow('资源已更新')
    expect(f.registry.sendBrowserCommand).not.toHaveBeenCalled()
  })
  it('rejects concurrent input and restores availability after dispatch failure', async () => {
    const f = await fixture(); await f.runtime.start()
    f.registry.sendBrowserCommand.mockImplementationOnce(async () => {
      await expect(f.runtime.input('hello')).rejects.toThrow('清空')
      await expect(f.runtime.clear()).rejects.toThrow('正在处理')
      throw new Error('transport failed')
    })
    await expect(f.runtime.clear()).rejects.toThrow('transport failed')
    await expect(f.runtime.input('hello')).resolves.toBeUndefined()
  })
})

describe('supervisor runtime gates', () => {
  it('authenticates the Unix gateway and separates user requests from patrol', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.runtime.root, 'credentials.json'), 'utf8'))
    expect((await rpc(credentials.socketPath, 'bad', '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })).status).toBe(403)
    expect((await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })).status).toBe(200)
    const command = { request: { operation: 'record', args: {} } }
    expect((await rpc(credentials.socketPath, credentials.token, '/execute', command)).status).toBe(403)
    await f.runtime.input('给 TASK-102 记一条：后端正在开发')
    const input = f.registry.sendBrowserCommand.mock.calls[0] as unknown as [string, string, {text:string}]
    const grantRef = input[2].text.match(/supervisor-user-grant:([^\]]+)/)![1]
    expect((await rpc(credentials.socketPath, credentials.token, '/execute', { ...command, grantRef })).status).toBe(200)
    expect(f.service.execute).toHaveBeenLastCalledWith(command.request, expect.objectContaining({ userInitiated: true }))
    f.getDetail()!.summary.status = 'running'
    await expect(f.runtime.input('记录另一条')).rejects.toThrow('正在工作')
    expect((await rpc(credentials.socketPath, credentials.token, '/execute', { ...command, grantRef })).status).toBe(200)
    f.getDetail()!.summary.status = 'idle'
    f.registry.list.mockReturnValue([f.getDetail()!.summary, { ...f.getDetail()!.summary, sessionId: 'worker', processInstanceId: 'process-worker' }])
    await f.runtime.patrol()
    expect((await rpc(credentials.socketPath, credentials.token, '/execute', { ...command, grantRef })).status).toBe(403)
    expect(f.registry.release).toHaveBeenCalled()
  })
  it('lets only a user turn archive pasted screenshots', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.runtime.root, 'credentials.json'), 'utf8'))
    await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })
    const args = { name: '截图.png', mime: 'image/png', data: 'AAAA' }
    expect((await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'attachment_put', args }, userTurn: true })).status).toBe(200)
    const refused = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'attachment_put', args }, userTurn: false })
    expect(refused.status).toBe(403)
    expect(String(refused.body.error)).toContain('自动巡查轮不能写附件')
  })
  it('treats an untagged user turn as authorization, so no marker or confirmation is needed', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.runtime.root, 'credentials.json'), 'utf8'))
    await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })
    const command = { request: { operation: 'record', args: {} } }
    // No marker/grant: the extension says this turn is a real user message (typed in the pane or the page).
    const allowed = await rpc(credentials.socketPath, credentials.token, '/execute', { ...command, userTurn: true })
    expect(allowed.status).toBe(200)
    expect(f.service.execute).toHaveBeenLastCalledWith(command.request, expect.objectContaining({ userInitiated: true }))
    // The owner asked for no confirmation step: a user turn authorizes its writes whatever the wording is.
    const plain = { request: { operation: 'task_create', args: {} }, userTurn: true, userPrompt: '这个 EU 项目你看着整理一下' }
    const allowedTask = await rpc(credentials.socketPath, credentials.token, '/execute', plain)
    expect(allowedTask.status).toBe(200)
    // Any real-user wording works, including one that names no operation at all.
    const realPhrase = await rpc(credentials.socketPath, credentials.token, '/execute', { ...command, userTurn: true, userPrompt: '帮我把这个记录到对应任务的记录里 US的risktag gpu 推理优化' })
    expect(realPhrase.status).toBe(200)
    // An automatic patrol turn (or a batch that does not claim a user turn) stays read-only.
    const refused = await rpc(credentials.socketPath, credentials.token, '/execute', { ...command, userTurn: false })
    expect(refused.status).toBe(403)
    expect(String(refused.body.error)).toContain('不能创建或修改任务')
    // The patrol prompt carries the machine tag the extension uses to spot its own automatic turns.
    f.registry.list.mockReturnValue([f.getDetail()!.summary, { ...f.getDetail()!.summary, sessionId: 'worker', processInstanceId: 'process-worker' }])
    await f.runtime.patrol()
    const patrolText = (f.registry.sendBrowserCommand.mock.calls.at(-1) as unknown as [string, string, { text: string }])[2].text
    expect(patrolText.startsWith('[supervisor-auto-patrol]')).toBe(true)
  })
  it('自动巡查轮仍不能写：这是唯一保留的写入边界', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.runtime.root, 'credentials.json'), 'utf8'))
    await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })
    const patrol = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'task_create', args: {} }, userTurn: false })
    expect(patrol.status).toBe(403)
    expect(String(patrol.body.error)).toContain('不能创建或修改任务')
    // The same write from a real user turn goes through without any confirmation flag.
    const user = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'task_create', args: {} }, userTurn: true, userPrompt: '这个 EU 项目你看着整理一下' })
    expect(user.status).toBe(200)
  })
  it('扩展源码更新只提示重启，不再暂停读写通道', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.runtime.root, 'credentials.json'), 'utf8'))
    await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })
    await writeFile(f.config.agentResources.extensionPaths[0], 'export default function changed() {}')
    const read = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'context', args: {} } })
    expect(read.status).toBe(200)
    // The Agent is told its own code is older, so it can say so instead of silently behaving differently.
    expect(JSON.stringify(read.body.result)).toContain('扩展代码已更新')
    const state = await f.runtime.state()
    expect(state.agent.resourceState).toBe('loaded')
    expect(state.agent.extensionsStale).toBe(true)
    // Instruction text is not a launch argument: an edited Skill keeps the channel open and the Agent is
    // told its own instructions are older.
    await writeFile(path.join(f.config.agentResources.skillPaths[0], 'SKILL.md'), '---\nname: supervisor\ndescription: Testing supervisor\n---\nChanged after start')
    const afterSkill = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'context', args: {} } })
    expect(afterSkill.status).toBe(200)
    expect(JSON.stringify(afterSkill.body.result)).toContain('角色或 Skill 内容已更新')
  })
  it('启动形状变化也不再暂停通道，只给重启提示', async () => {
    const f = await fixture(); await f.runtime.start()
    const credentials = JSON.parse(await readFile(path.join(f.runtime.root, 'credentials.json'), 'utf8'))
    expect((await rpc(credentials.socketPath, credentials.token, '/loaded', { revision: credentials.revision, tools: credentials.allowedTools })).status).toBe(200)
    await f.runtime.input('查一下当前任务')
    const grantRef = (f.registry.sendBrowserCommand.mock.calls[0] as unknown as [string, string, { text: string }])![2].text.match(/supervisor-user-grant:([^\]]+)/)![1]
    // A launch-shape change (here: the tool allowlist) no longer matches the running session's revision.
    f.config.agentResources.allowedTools.push('event_correct')
    const read = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'context', args: {} }, grantRef })
    const write = await rpc(credentials.socketPath, credentials.token, '/execute', { request: { operation: 'record', args: {} }, grantRef })
    // The owner asked for zero gating: reads and writes keep working, the mismatch only shows up as a notice.
    expect([read.status, write.status]).toEqual([200, 200])
    expect(JSON.stringify(read.body.result)).toContain('监督配置已变更')
    expect(f.service.execute).toHaveBeenCalled()
  })
  it('does not steal a human lease and revokes requests when config changes', async () => {
    const f = await fixture(); await f.runtime.start(); f.getDetail()!.summary.claim = { state: 'claimed', leaseId: 'human' }
    await expect(f.runtime.input('记录 TASK-102 进展')).rejects.toThrow('控制权'); expect(f.registry.sendBrowserCommand).not.toHaveBeenCalled()
    f.getDetail()!.summary.claim = { state: 'unclaimed' }; f.config.enabled = false
    await expect(f.runtime.input('记录 TASK-102 进展')).rejects.toThrow()
    await expect(f.runtime.coordinate({ sessionId: 'other' })).rejects.toThrow('观察模式')
  })
  it('blocks a second writer and restricted paths', async () => {
    const f = await fixture()
    const duplicate = new SupervisorRuntime({ root: f.runtime.root, getConfig: () => f.config, registry: f.registry as unknown as LiveSessionRegistry, service: f.service as unknown as SupervisorService, liveConfig: DEFAULT_LIVE_SESSION_CONFIG }); runtimes.push(duplicate)
    await expect(duplicate.boot()).rejects.toThrow('第二个')
    await expect(f.runtime.inspect({ path: '/etc/passwd' })).rejects.toThrow('范围')
    await expect(f.runtime.inspect({ path: f.runtime.root })).rejects.toThrow('范围')
    expect(await f.runtime.inspect({ path: f.config.agentResources.rolePath })).toMatchObject({ content: '# Role' })
  })
})
it('does not confuse idle or absent activity with a proven failure', () => {  const config = normalizeSupervisorConfig({})
  expect(config.eventTypes).toEqual(SUPERVISOR_STANDARD_EVENT_TYPES)
  expect(normalizeSupervisorConfig({ eventTypes: ['interview', 'review'] }).eventTypes).toEqual(['interview', 'review'])
  expect(normalizeSupervisorConfig({ eventTypes: ['interview', 'interview', ' review '] }).eventTypes).toEqual(['interview', 'review'])
  expect(normalizeSupervisorConfig({ eventTypes: [] }).eventTypes).toEqual(SUPERVISOR_STANDARD_EVENT_TYPES)
  expect(normalizeSupervisorConfig({ eventTypes: ['working_state'] }).eventTypes).toEqual(SUPERVISOR_STANDARD_EVENT_TYPES)
  expect(normalizeEventTypes(['Bad Case', 7])).toBeNull()
  expect(normalizeEventTypes(['suggestion'])).toBeNull()
  expect(normalizeEventTypes(Array.from({ length: 33 }, (_, index) => `t${index}`))).toBeNull()
  expect(observeSession(undefined, config).observation).toBe('offline')
  const detail = { summary: { status: 'idle', lastActivityAt: Date.now() }, entries: [], pendingUi: [] } as unknown as LiveSessionDetail
  expect(observeSession(detail, config).observation).toBe('idle')
  detail.pendingUi = [{ id: 'question' }] as LiveSessionDetail['pendingUi']; expect(observeSession(detail, config).observation).toBe('waiting_input')
  expect(userOperations('现在任务怎么样？')).toEqual([]); expect(userOperations('创建任务：接口联调')).toContain('task_create')
  expect(userOperations('不要创建任务')).toEqual([]); expect(userOperations('谁更新了任务状态')).toEqual([])
  expect(userOperations('创建任务是什么意思？')).toEqual([])
  expect(userOperations('记录后端说：不要创建任务')).toEqual(['record'])
  expect(userOperations('帮我把这个记录到对应任务的记录里 US 的 risktag gpu 推理优化')).toEqual(['record'])
  expect(userOperations('帮我记一下今天的评审')).toEqual(['record'])
})
it('blocks archive access through generic file endpoints, relative paths and symlink aliases', async () => {
  const f = await fixture(); await f.runtime.start()
  const alias = path.join(f.root, 'alias'); await symlink(f.runtime.root, alias)
  const paths = [path.join(f.runtime.root, 'credentials.json'), path.relative(process.cwd(), path.join(f.runtime.root, 'credentials.json')), path.join(alias, 'credentials.json')]
  for (const api of ['/api/file-read', '/api/FILE-read', '/api/local-file', '/api/LOCAL-file/download']) for (const file of paths) {
    const json = vi.fn(), status = vi.fn(() => ({ json })), next = vi.fn()
    await protectSupervisorFiles(f.runtime.root, {} as LiveSessionBrowserAuth)({ path: api, query: { path: file } } as unknown as Request, { status } as unknown as Response, next)
    expect(status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled()
  }
})
