import { describe, expect, it } from 'vitest'
import { parseClaudeCodeUsageLimits, parseCodexUsageLimits, UsageLimitsService } from '../usage-limits.js'

describe('usage limit parsing', () => {
  it('maps Codex windows by duration rather than primary/secondary position', () => {
    expect(parseCodexUsageLimits({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 24, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 78, windowDurationMins: 300, resetsAt: 1_700_000_000 },
        },
        other: { limitId: 'other', primary: { usedPercent: 100, windowDurationMins: 300 } },
      },
      rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } },
    })).toEqual([
      { period: 'five-hour', usedPercent: 78, resetsAt: 1_700_000_000_000, durationMinutes: 300 },
      { period: 'weekly', usedPercent: 24, resetsAt: 1_800_000_000_000, durationMinutes: 10_080 },
    ])
  })

  it('keeps a weekly-only Codex account from being mislabeled as a 5-hour window', () => {
    expect(parseCodexUsageLimits({
      rateLimits: { primary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: null }, secondary: null },
    })).toEqual([
      { period: 'weekly', usedPercent: 41, resetsAt: null, durationMinutes: 10_080 },
    ])
  })

  it('parses Claude Code fractional utilization and reset dates', () => {
    expect(parseClaudeCodeUsageLimits({
      five_hour: { utilization: 0.327, resets_at: '2026-01-02T03:04:05.000Z' },
      seven_day: { utilization: 0.64, resets_at: null },
      seven_day_opus: { utilization: 0.9, resets_at: '2026-01-03T00:00:00Z' },
    })).toEqual([
      { period: 'five-hour', usedPercent: 32.7, resetsAt: Date.parse('2026-01-02T03:04:05.000Z'), durationMinutes: 300 },
      { period: 'weekly', usedPercent: 64, resetsAt: null, durationMinutes: 10_080 },
    ])
  })
})

describe('UsageLimitsService', () => {
  it('deduplicates in-flight reads and caches the snapshot for the configured TTL', async () => {
    let now = 1_000
    let codexReads = 0
    let claudeReads = 0
    const service = new UsageLimitsService({
      codex: async () => {
        codexReads += 1
        return { provider: 'codex', status: 'available', windows: [] }
      },
      claudeCode: async () => {
        claudeReads += 1
        return { provider: 'claude-code', status: 'unavailable', windows: [] }
      },
    }, 100, () => now)

    const [first, concurrent] = await Promise.all([service.getReport(), service.getReport()])
    expect(first).toBe(concurrent)
    expect(first.checkedAt).toBe(1_000)
    expect(codexReads).toBe(1)
    expect(claudeReads).toBe(1)

    now = 1_099
    expect(await service.getReport()).toBe(first)
    now = 1_100
    expect((await service.getReport()).checkedAt).toBe(1_100)
    expect(codexReads).toBe(2)
    expect(claudeReads).toBe(2)
  })
})
