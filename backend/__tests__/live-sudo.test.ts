import { afterEach, describe, expect, it } from 'vitest'
import { LiveSessionRegistry } from '../live-sessions/registry.js'
import { validateLiveSessionCommand } from '../live-sessions/protocol.js'

const registries: LiveSessionRegistry[] = []
afterEach(async () => { await Promise.all(registries.splice(0).map(r => r.stop())) })
function fixture() {
  let now = 1000
  const registry = new LiveSessionRegistry({ now: () => now, goalFileSyncIntervalMs: 0, resyncRetryIntervalMs: 0 })
  registries.push(registry)
  const sent: unknown[] = []
  const transport = { send(envelope: any) {
    if (envelope.type !== 'command') return
    if (envelope.command.type !== 'resync') sent.push(envelope.command)
    queueMicrotask(() => registry.handleCommandResult({ type: 'command_result', requestId: envelope.requestId, ok: true, result: { accepted: true, unsafeExtra: 'never-return-this' } }, transport))
  } }
  registry.connect({ type: 'hello', protocolVersion: 2, brokerToken: 'token', processInstanceId: 'p', sessionId: 's', pid: 42, cwd: '/tmp', mode: 'tui' }, '/tmp', transport)
  registry.applySnapshot({ type: 'snapshot', processInstanceId: 'p', revision: 1, sequence: 0, summary: { processInstanceId: 'p', sessionId: 's', pid: 42, cwd: '/tmp', canonicalCwd: '/tmp', mode: 'tui', status: 'running', claim: { state: 'unclaimed' }, startedAt: 1, lastActivityAt: 2, revision: 1, eventSequence: 0 }, entries: [] }, transport, '/tmp')
  registry.applyEvent({ type: 'event', processInstanceId: 'p', sequence: 1, event: { type: 'extension_ui', data: { id: 'sudo-1', method: 'sudo', title: 'Authorize', message: '检查 UID，不修改文件。', host: 'machine', cwd: '/tmp', command: '["/usr/bin/id"]', expiresAt: 2000 } } }, transport)
  sent.length = 0 // discard the initial snapshot handshake's resync
  return { registry, sent, transport, expire: () => { now = 3000 } }
}
describe('dedicated sudo answer channel', () => {
  it('retains the execution explanation and immutable argv in the projected request', () => {
    const { registry } = fixture()
    expect(registry.get('p')?.pendingUi[0]).toMatchObject({
      method: 'sudo', message: '检查 UID，不修改文件。', command: '["/usr/bin/id"]',
    })
  })
  it('validates a bounded secret without accepting replacement commands or ambiguous cancellation', () => {
    expect(validateLiveSessionCommand({ type: 'answer_sudo', id: 'id', password: '' }, true).type).toBe('answer_sudo')
    for (const extra of [{ password: 'a\nb' }, { password: 'x'.repeat(4097) }, { password: 'x', executable: '/bad' }, { password: 'x', cancelled: true }]) {
      expect(() => validateLiveSessionCommand({ type: 'answer_sudo', id: 'id', ...extra }, true)).toThrow()
    }
  })
  it('requires a live matching request and does not return extra bridge response data', async () => {
    const { registry, sent } = fixture()
    await expect(registry.sendBrowserCommand('p', 'b', { type: 'answer_sudo', id: 'unknown', password: 'test-secret' })).rejects.toThrow(/expired or unavailable/)
    await expect(registry.sendBrowserCommand('p', 'b', { type: 'answer_ui', id: 'sudo-1', value: 'test-secret' })).rejects.toThrow(/dedicated/)
    expect(sent).toHaveLength(0)
    expect(await registry.sendBrowserCommand('p', 'b', { type: 'answer_sudo', id: 'sudo-1', password: 'test-secret' })).toEqual({ accepted: true })
  })
  it('rejects expiry and closure before transmitting credentials', async () => {
    const { registry, sent, expire } = fixture(); expire()
    await expect(registry.sendBrowserCommand('p', 'b', { type: 'answer_sudo', id: 'sudo-1', password: 'test-secret' })).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })
})
