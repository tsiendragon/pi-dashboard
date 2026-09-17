import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { UsageLedger } from '../usage-ledger.js'

const usage = (input, output, cost) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
})

describe('UsageLedger', () => {
  it('persists session usage and aggregates daily, model, and session totals', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-'))
    const ledgerDirectory = path.join(dir, 'token-usage')
    const sessionFile = path.join(dir, 'session.jsonl')
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-a', timestamp: '2026-09-01T00:00:00.000Z', cwd: '/tmp/task' }),
      JSON.stringify({ type: 'message', id: 'entry-1', timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet', timestamp: Date.parse('2026-09-03T10:00:00.000Z'), usage: usage(1000, 100, 0.01) } }),
      JSON.stringify({ type: 'message', id: 'entry-2', timestamp: '2026-09-04T10:00:00.000Z', message: { role: 'assistant', provider: 'anthropic', model: 'claude-opus', timestamp: Date.parse('2026-09-04T10:00:00.000Z'), usage: usage(2000, 200, 0.04) } }),
      JSON.stringify({ type: 'compaction', id: 'entry-3', timestamp: '2026-09-04T11:00:00.000Z', usage: usage(300, 30, 0.005) }),
    ].join('\n') + '\n')

    const ledger = new UsageLedger(ledgerDirectory)
    expect(await ledger.ingestSessionFile(sessionFile, { sessionFile, label: 'Task A', cwd: '/tmp/task' })).toBe(3)
    expect(await ledger.ingestSessionFile(sessionFile, { sessionFile, label: 'Task A', cwd: '/tmp/task' })).toBe(0)

    const report = await ledger.getReport('2026-09', 'UTC')
    expect(report.daily).toHaveLength(30)
    expect(report.daily.find(item => item.date === '2026-09-03')).toMatchObject({
      costUsd: 0.01,
      totalTokens: 1100,
      models: [{ key: 'anthropic/claude-sonnet', costUsd: 0.01, totalTokens: 1100 }],
    })
    expect(report.daily.find(item => item.date === '2026-09-04')).toMatchObject({
      costUsd: 0.045,
      totalTokens: 2530,
      models: expect.arrayContaining([
        expect.objectContaining({ key: 'anthropic/claude-opus', costUsd: 0.04 }),
        expect.objectContaining({ key: 'Tools/summaries', costUsd: 0.005 }),
      ]),
    })
    expect(report.models.map(item => item.key)).toEqual(['anthropic/claude-opus', 'anthropic/claude-sonnet', 'Tools/summaries'])
    expect(report.sessions[0]).toMatchObject({ key: 'session-a', label: 'Task A', costUsd: 0.055 })

    const persisted = await readFile(path.join(ledgerDirectory, '2026-09.jsonl'), 'utf8')
    expect(persisted.trim().split('\n')).toHaveLength(3)
    const restored = new UsageLedger(ledgerDirectory)
    expect((await restored.getReport('2026-09', 'UTC')).total).toMatchObject({ costUsd: 0.055, totalTokens: 3630 })
  })

  it('keeps a provider-qualified response model from double-prefixing the key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-qualified-'))
    const ledgerDirectory = path.join(dir, 'token-usage')
    const sessionFile = path.join(dir, 'session.jsonl')
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-q', timestamp: '2026-09-01T00:00:00.000Z', cwd: '/tmp/self-hosted' }),
      JSON.stringify({ type: 'message', id: 'entry-q1', timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'assistant', provider: 'dsw', model: 'deepseek_v41_flash', responseModel: 'dsw/deepseek_v41_flash', timestamp: Date.parse('2026-09-03T10:00:00.000Z'), usage: usage(1000, 100, 0) } }),
    ].join('\n') + '\n')

    const ledger = new UsageLedger(ledgerDirectory)
    await ledger.ingestSessionFile(sessionFile, { sessionFile, label: 'Self-hosted', cwd: '/tmp/self-hosted' })
    const report = await ledger.getReport('2026-09', 'UTC')
    expect(report.models.map(item => item.key)).toEqual(['dsw/deepseek_v41_flash'])
  })

  it('records terminal live events with an entry id once', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-usage-live-'))
    const ledger = new UsageLedger(path.join(dir, 'token-usage'))
    const summary = {
      processInstanceId: 'process-a',
      sessionId: 'session-a',
      sessionFile: path.join(dir, 'session.jsonl'),
      canonicalCwd: '/tmp/terminal-task',
      sessionName: 'Terminal Task',
    }
    const event = {
      type: 'event', processInstanceId: 'process-a', sequence: 4,
      event: { type: 'message_end', data: { entryId: 'entry-4', message: { role: 'assistant', provider: 'openai', model: 'gpt-test', timestamp: '2026-09-05T00:00:00.000Z', usage: usage(500, 50, 0.02) } } },
    }
    expect(await ledger.recordLiveEvent(event, summary)).toBe(true)
    expect(await ledger.recordLiveEvent(event, summary)).toBe(false)
    expect((await ledger.getReport('2026-09', 'UTC')).sessions[0]).toMatchObject({ key: 'session-a', costUsd: 0.02 })
  })
})
