import { describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { TimingLedger } from '../timing-ledger.js'

const at = (iso) => Date.parse(iso)

function modelLine(overrides = {}) {
  return JSON.stringify({
    v: 1,
    id: `m-${Math.random().toString(16).slice(2)}`,
    at: at('2026-09-03T10:00:00.000Z'),
    kind: 'model',
    sessionId: 'session-a',
    scope: 'root',
    provider: 'anthropic',
    model: 'claude-test',
    totalMs: 1000,
    outputTokens: 200,
    cwd: '/tmp/task-a',
    ...overrides,
  })
}

describe('TimingLedger', () => {
  it('aggregates per-model latency, thinking, tool, and run wall clock', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-timing-ledger-'))
    const timingDir = path.join(dir, 'timing')
    const sessionFile = path.join(timingDir, 'session-a.jsonl')
    await mkdir(timingDir, { recursive: true })
    await writeFile(sessionFile, [
      modelLine({ ttftMs: 500, thinkingMs: 300 }),
      modelLine({ id: 'm-2', ttftMs: 1500, totalMs: 3000, outputTokens: 400 }),
      modelLine({ id: 'm-child', scope: 'child', ttftMs: 400, totalMs: 800, outputTokens: 100, model: 'claude-test' }),
      JSON.stringify({
        v: 1, id: 't-1', at: at('2026-09-03T10:05:00.000Z'), kind: 'tool', sessionId: 'session-a',
        scope: 'root', toolName: 'bash', durationMs: 60_000, isError: false, cwd: '/tmp/task-a',
      }),
      JSON.stringify({
        v: 1, id: 't-2', at: at('2026-09-03T10:06:00.000Z'), kind: 'tool', sessionId: 'session-a',
        scope: 'root', toolName: 'read', durationMs: 100, isError: false, cwd: '/tmp/task-a',
      }),
      JSON.stringify({
        v: 1, id: 'r-1', at: at('2026-09-03T10:10:00.000Z'), kind: 'run', sessionId: 'session-a',
        scope: 'root', durationMs: 120_000, cwd: '/tmp/task-a',
      }),
      JSON.stringify({
        v: 1, id: 'r-child', at: at('2026-09-03T10:11:00.000Z'), kind: 'run', sessionId: 'session-b',
        scope: 'child', durationMs: 30_000, cwd: '/tmp/task-a',
      }),
      '{"v":1,"id":"broken"',
    ].join('\n') + '\n')

    const ledger = new TimingLedger(timingDir, 'UTC', 0)
    const report = await ledger.getReport('month', '2026-09', 'UTC')
    expect(report.daily).toHaveLength(30)
    expect(report.total.modelCalls).toBe(3)
    expect(report.total.toolCalls).toBe(2)
    expect(report.total.runs).toBe(1)
    expect(report.total.childRuns).toBe(1)
    // Root wall clock excludes the child run and the parent tool overlap.
    expect(report.total.activeMs).toBe(120_000)
    expect(report.total.childActiveMs).toBe(30_000)
    expect(report.total.modelMs).toBe(4000)
    expect(report.total.toolMs).toBe(60_100)
    expect(report.total.overheadMs).toBe(120_000 - 4000 - 60_100)
    expect(report.total.ttftCalls).toBe(3)
    expect(report.total.ttftMs).toBe(2400)
    expect(report.total.thinkingCalls).toBe(1)
    expect(report.total.thinkingMs).toBe(300)
    expect(report.recordCount).toBe(7)

    const model = report.models[0]
    expect(model.key).toBe('anthropic/claude-test')
    expect(model.calls).toBe(3)
    expect(model.totalMs).toBe(4800)
    expect(model.ttftP50Ms).toBe(500)
    expect(model.ttftP90Ms).toBe(1500)
    expect(model.thinkingShare).toBeCloseTo(300 / 4800, 5)
    expect(model.decodeTokensPerSec).toBeCloseTo(700 / ((4800 - 2400) / 1000), 5)

    const bash = report.tools.find(tool => tool.name === 'bash')
    expect(bash).toMatchObject({ calls: 1, totalMs: 60_000, p90Ms: 60_000, maxMs: 60_000 })
    expect(report.sessions[0]).toMatchObject({ key: 'session-a', runs: 1, activeMs: 120_000, modelMs: 4000, toolMs: 60_100 })
  })

  it('picks up appended records without re-counting earlier ones', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-timing-tail-'))
    const timingDir = path.join(dir, 'timing')
    const sessionFile = path.join(timingDir, 'session-a.jsonl')
    await mkdir(timingDir, { recursive: true })
    await writeFile(sessionFile, `${modelLine()}\n`)

    const ledger = new TimingLedger(timingDir, 'UTC', 0)
    expect((await ledger.getReport('month', '2026-09', 'UTC')).total.modelCalls).toBe(1)

    await appendFile(sessionFile, `${modelLine({ id: 'm-appended' })}\n`)
    expect((await ledger.getReport('month', '2026-09', 'UTC')).total.modelCalls).toBe(2)

    await appendFile(sessionFile, '{"v":1,"id":"partial-line"')
    expect((await ledger.getReport('month', '2026-09', 'UTC')).total.modelCalls).toBe(2)

    // Completing the partial line yields an invalid record; it is skipped and the
    // offset still advances, so the next valid line is ingested exactly once.
    await appendFile(sessionFile, '}\n')
    expect((await ledger.getReport('month', '2026-09', 'UTC')).total.modelCalls).toBe(2)
    await appendFile(sessionFile, `${modelLine({ id: 'm-after-partial' })}\n`)
    expect((await ledger.getReport('month', '2026-09', 'UTC')).total.modelCalls).toBe(3)
    expect((await ledger.getReport('month', '2026-09', 'UTC')).recordCount).toBe(3)
  })

  it('supports rolling 7d and 30d windows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-timing-range-'))
    const timingDir = path.join(dir, 'timing')
    const now = Date.now()
    await mkdir(timingDir, { recursive: true })
    await writeFile(path.join(timingDir, 'session-a.jsonl'), [
      modelLine({ id: 'recent', at: now - 60_000 }),
      modelLine({ id: 'old', at: now - 20 * 24 * 60 * 60 * 1000 }),
    ].join('\n') + '\n')

    const ledger = new TimingLedger(timingDir, 'UTC', 0)
    expect((await ledger.getReport('7d', undefined, 'UTC')).total.modelCalls).toBe(1)
    expect((await ledger.getReport('30d', undefined, 'UTC')).total.modelCalls).toBe(2)
  })
})