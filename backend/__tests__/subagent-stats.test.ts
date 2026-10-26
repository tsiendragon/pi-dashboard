import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { SubagentStatsLedger } from '../subagent-stats.js'

const DAY = 86_400_000

async function seed(lines: readonly unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-subagent-stats-'))
  await writeFile(
    path.join(dir, 'subagent-jobs.jsonl'),
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
  )
  return dir
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, at: Date.now(), kind: 'agent', ...overrides }
}

describe('SubagentStatsLedger', () => {
  it('takes the last row per job and splits success from failure', async () => {
    const now = Date.now()
    const dir = await seed([
      row({ workId: 'work_ok', status: 'queued', role: 'code', tier: 'light', createdAt: now - 60_000 }),
      row({
        workId: 'work_ok',
        status: 'completed',
        role: 'code',
        tier: 'light',
        model: 'a/one',
        completedAt: now - 30_000,
        usage: { input: 10, output: 500, cacheRead: 1000, cacheWrite: 2000, cost: 0.01 },
        toolCalls: 7,
        modelCalls: 3,
      }),
      row({ workId: 'work_bad', status: 'queued', role: 'read_only', createdAt: now - 50_000 }),
      row({ workId: 'work_bad', status: 'failed', role: 'read_only', model: 'a/two', error: 'boom', completedAt: now - 20_000 }),
      row({ workId: 'work_run', status: 'running', role: 'code', createdAt: now - 10_000 }),
    ])
    const report = await new SubagentStatsLedger({ ledgerDir: dir }).getReport(7, 'UTC')

    expect(report.empty).toBe(false)
    expect(report.records).toBe(5)
    expect(report.totals).toMatchObject({
      launched: 3,
      completed: 1,
      failed: 1,
      running: 1,
      settled: 2,
    })
    expect(report.totals.successRate).toBeCloseTo(0.5)
    expect(report.byKind).toEqual([expect.objectContaining({ key: 'agent', launched: 3 })])
    // A row without `role` is the controller default, so it joins the `code` row.
    expect(report.byRole.filter((row) => row.key === 'code')).toHaveLength(1)
    expect(report.byRole).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'code', launched: 2, completed: 1, running: 1, successRate: 1 }),
        expect.objectContaining({ key: 'read_only', launched: 1, failed: 1, successRate: 0 }),
      ]),
    )
    expect(report.byModel).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'a/one', completed: 1 })]),
    )
    expect(report.totals.usage).toMatchObject({
      input: 10,
      output: 500,
      cacheRead: 1000,
      cacheWrite: 2000,
      cost: 0.01,
      reported: 1,
      toolCalls: 7,
      modelCalls: 3,
    })
    expect(report.recentFailures).toEqual([
      expect.objectContaining({ workId: 'work_bad', status: 'failed', error: 'boom', role: 'read_only' }),
    ])
    expect(report.days).toHaveLength(7)
    const totalFromDays = report.days.reduce((sum, day) => sum + day.launched, 0)
    expect(totalFromDays).toBe(3)
  })

  it('counts workflow child tasks and keeps cancellations out of the success rate', async () => {
    const now = Date.now()
    const dir = await seed([
      row({ workId: 'work_wf', kind: 'workflow', status: 'queued', createdAt: now - 60_000 }),
      row({
        workId: 'work_wf',
        kind: 'workflow',
        status: 'failed',
        tasks: 3,
        tasksFailed: 1,
        error: 'stage 2 failed',
        completedAt: now - 30_000,
      }),
      row({ workId: 'work_cancel', status: 'queued', createdAt: now - 20_000 }),
      row({ workId: 'work_cancel', status: 'cancelled', completedAt: now - 10_000 }),
    ])
    const report = await new SubagentStatsLedger({ ledgerDir: dir }).getReport(7, 'UTC')

    expect(report.totals).toMatchObject({
      launched: 2,
      failed: 1,
      cancelled: 1,
      tasks: 3,
      tasksFailed: 1,
    })
    // 0 completed vs 1 failed; the cancelled job is not in the denominator.
    expect(report.totals.successRate).toBe(0)
    expect(report.byKind).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'workflow', launched: 1, failed: 1 }),
        expect.objectContaining({ key: 'agent', launched: 1, cancelled: 1 }),
      ]),
    )
  })

  it('drops rows outside the window, skips bad lines, and reports an empty ledger', async () => {
    const now = Date.now()
    const dir = await seed([
      row({ workId: 'work_old', status: 'completed', completedAt: now - 40 * DAY }),
      row({ workId: 'work_new', status: 'completed', completedAt: now - 1_000 }),
      '{"workId":"broken"',
      '{"nothing":"useful"}',
    ])
    const report = await new SubagentStatsLedger({ ledgerDir: dir }).getReport(7, 'UTC')
    expect(report.records).toBe(2)
    expect(report.totals.launched).toBe(1)
    expect(report.recentFailures).toEqual([])

    const missing = await new SubagentStatsLedger({ ledgerDir: path.join(dir, 'missing') }).getReport(7, 'UTC')
    expect(missing.empty).toBe(true)
    expect(missing.totals.launched).toBe(0)
    expect(missing.days).toHaveLength(7)
  })

  it('clamps the window to 1..90 days', async () => {
    const dir = await seed([])
    const ledger = new SubagentStatsLedger({ ledgerDir: dir })
    expect((await ledger.getReport(0, 'UTC')).windowDays).toBe(1)
    expect((await ledger.getReport(500, 'UTC')).windowDays).toBe(90)
  })
})