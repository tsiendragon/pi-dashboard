import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveSessionRegistry } from '../live-sessions/registry.js'

const children: ChildProcess[] = []
const registries: LiveSessionRegistry[] = []
afterEach(async () => {
  registries.splice(0).forEach(registry => registry.stop())
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })))
})

describe('subagent trace lineage', () => {
  it.skipIf(process.platform !== 'linux')('keeps workflow task identity separate from Pi session and work handle', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { env: {
      ...process.env,
      PI_SUBAGENT_WORKBENCH_CHILD: '1',
      PI_TRACE_CONTEXT: JSON.stringify({ parentSessionId: 'parent', parentToolCallId: 'call', workId: 'work-1', taskId: 'stage-task-1' }),
    } })
    children.push(child)
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    const registry = new LiveSessionRegistry()
    registries.push(registry)
    const transport = { send() {} }
    const summary = {
      processInstanceId: 'lineage-child', sessionId: 'actual-pi-id', pid: child.pid!,
      cwd: '/tmp', canonicalCwd: '/tmp', mode: 'rpc' as const, status: 'idle' as const,
      claim: { state: 'unclaimed' as const }, startedAt: 0, lastActivityAt: 0, revision: 1, eventSequence: 0,
    }
    registry.connect({ type: 'hello', protocolVersion: 2, brokerToken: 'test', ...summary }, '/tmp', transport)
    registry.applySnapshot({ type: 'snapshot', processInstanceId: summary.processInstanceId, revision: 1, sequence: 0, summary, entries: [] }, transport, '/tmp')
    expect(registry.get(summary.processInstanceId)?.summary).toMatchObject({
      role: 'subagent', parentSessionId: 'parent', parentToolCallId: 'call',
      subagentWorkId: 'work-1', subagentTaskId: 'stage-task-1', sessionId: 'actual-pi-id',
    })
  })
})
