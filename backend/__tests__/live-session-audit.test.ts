import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveSessionAuditStore, parseAuditLine } from '../live-sessions/audit.js'
import { LiveSessionRegistry } from '../live-sessions/registry.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())) })

async function tempAudit(): Promise<{ store: LiveSessionAuditStore; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'pidash-audit-'))
  const filePath = join(dir, 'audit.jsonl')
  const store = new LiveSessionAuditStore({ filePath, now: () => 1000 })
  // Flush before removing: an append that lands after rm would recreate the file.
  cleanups.push(async () => { await store.flush(); await rm(dir, { recursive: true, force: true }) })
  await store.start()
  return { store, filePath }
}

function fixture(audit: LiveSessionAuditStore) {
  const registry = new LiveSessionRegistry({ audit, goalFileSyncIntervalMs: 0, resyncRetryIntervalMs: 0 })
  cleanups.push(() => registry.stop())
  const transport = {
    send(envelope: any) {
      if (envelope.type !== 'command') return
      const result = envelope.command.type === 'cancel_queue_item'
        ? { cancelled: true, remaining: 1 }
        : { accepted: true }
      queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result }, transport))
    },
  }
  registry.connect({ type: 'hello', protocolVersion: 2, brokerToken: 'token', processInstanceId: 'p', sessionId: 'session-1', pid: 42, cwd: '/tmp', mode: 'tui' }, '/tmp', transport)
  registry.applySnapshot({
    type: 'snapshot', processInstanceId: 'p', revision: 1, sequence: 0,
    summary: {
      processInstanceId: 'p', sessionId: 'session-1', pid: 42, cwd: '/tmp', canonicalCwd: '/tmp', mode: 'tui',
      status: 'running', claim: { state: 'unclaimed' }, startedAt: 1, lastActivityAt: 2, revision: 1, eventSequence: 0,
    },
    entries: [],
  }, transport, '/tmp')
  let sequence = 0
  const pushUi = (data: Record<string, unknown>) => {
    sequence += 1
    registry.applyEvent({ type: 'event', processInstanceId: 'p', sequence, event: { type: 'extension_ui', data } }, transport)
  }
  pushUi({ id: 'ui-1', method: 'confirm', title: '允许运行：rm -rf build', message: '/srv/demo' })
  return { registry, pushUi }
}

describe('live session audit store', () => {
  it('returns newest first and persists entries so a restart keeps them', async () => {
    const { store, filePath } = await tempAudit()
    store.record({ processInstanceId: 'p', action: 'allowed', method: 'confirm', title: '允许运行' })
    store.record({ processInstanceId: 'p', action: 'withdrawn', method: 'queue', detail: '剩余 1 条' })
    store.record({ processInstanceId: 'other', action: 'denied', method: 'confirm' })
    await store.flush()
    expect(store.recent('p').map(entry => entry.action)).toEqual(['withdrawn', 'allowed'])
    expect(store.recent('p', 1)).toHaveLength(1)

    const reloaded = new LiveSessionAuditStore({ filePath })
    await reloaded.start()
    expect(reloaded.recent('p').map(entry => entry.action)).toEqual(['withdrawn', 'allowed'])
    const text = await readFile(filePath, 'utf8')
    expect(text.trim().split('\n')).toHaveLength(3)
  })

  it('ignores corrupt lines instead of dropping the whole log', async () => {
    expect(parseAuditLine('not json')).toBeUndefined()
    expect(parseAuditLine('{"at":1}')).toBeUndefined()
    expect(parseAuditLine(JSON.stringify({ at: 1, processInstanceId: 'p', action: 'executed' }))).toBeUndefined()
    expect(parseAuditLine(JSON.stringify({ at: 1, processInstanceId: 'p', action: 'allowed' }))).toMatchObject({ action: 'allowed' })
  })

  it('truncates long titles and never accepts secrets', async () => {
    const { store } = await tempAudit()
    const entry = store.record({ processInstanceId: 'p', action: 'authorized', method: 'sudo', title: 'x'.repeat(400), detail: 'y'.repeat(400) })
    expect((entry.title ?? '').length).toBe(120)
    expect((entry.detail ?? '').length).toBe(200)
    expect(JSON.stringify(entry)).not.toContain('password')
  })
})

describe('registry records decisions', () => {
  it('records an allow and a deny with the request title and a shortened client id', async () => {
    const { store } = await tempAudit()
    const { registry, pushUi } = fixture(store)
    await registry.sendBrowserCommand('p', 'browser-123456789', { type: 'answer_ui', id: 'ui-1', value: 'true' })
    expect(store.recent('p')[0]).toMatchObject({
      action: 'allowed', method: 'confirm', title: '允许运行：rm -rf build', client: 'browser-',
    })
    pushUi({ id: 'ui-2', method: 'confirm', title: '再删一次' })
    await registry.sendBrowserCommand('p', 'browser-123456789', { type: 'answer_ui', id: 'ui-2', value: 'false' })
    expect(store.recent('p')[0]).toMatchObject({ action: 'denied', title: '再删一次' })
  })

  it('records a queued-prompt withdrawal only when the bridge confirms it', async () => {
    const { store } = await tempAudit()
    const { registry } = fixture(store)
    await registry.sendBrowserCommand('p', 'browser-1', { type: 'cancel_queue_item', id: 'q-1' })
    expect(store.recent('p')[0]).toMatchObject({ action: 'withdrawn', method: 'queue', detail: '剩余 1 条' })
  })

  it('records a sudo authorization without the password', async () => {
    const { store } = await tempAudit()
    const { registry, pushUi } = fixture(store)
    pushUi({ id: 'sudo-1', method: 'sudo', title: '管理员授权', expiresAt: Date.now() + 60_000 })
    await registry.sendBrowserCommand('p', 'browser-1', { type: 'answer_sudo', id: 'sudo-1', password: 'super-secret' })
    const latest = store.recent('p')[0]
    expect(latest).toMatchObject({ action: 'authorized', method: 'sudo' })
    expect(JSON.stringify(latest)).not.toContain('super-secret')
  })
})