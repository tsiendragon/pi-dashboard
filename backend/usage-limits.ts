import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import type { UsageLimitProviderReport, UsageLimitWindow, UsageLimitsReport } from '../shared/src/usage.js'

const CACHE_TTL_MS = 5 * 60 * 1000
const PROVIDER_TIMEOUT_MS = 15_000
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

interface UsageLimitReaders {
  codex: () => Promise<UsageLimitProviderReport>
  claudeCode: () => Promise<UsageLimitProviderReport>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function percent(value: unknown, fraction = false): number | undefined {
  const parsed = finiteNumber(value)
  if (parsed === undefined || parsed < 0) return undefined
  const normalized = fraction && parsed <= 1 ? parsed * 100 : parsed
  return Math.max(0, Math.min(100, normalized))
}

function timestamp(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function windowPeriod(durationMinutes: number | undefined): UsageLimitWindow['period'] | undefined {
  if (durationMinutes === 300) return 'five-hour'
  if (durationMinutes === 10_080) return 'weekly'
  return undefined
}

/** Parse the installed Codex app-server response without assuming primary == 5h. */
export function parseCodexUsageLimits(value: unknown): UsageLimitWindow[] {
  const root = object(value)
  if (!root) return []
  const snapshots = object(root.rateLimitsByLimitId)
  const entries = snapshots ? Object.entries(snapshots).map(([key, snapshot]) => [key, object(snapshot)] as const) : []
  const codexEntry = entries.find(([key, snapshot]) => {
    const label = `${key} ${String(snapshot?.limitId ?? '')} ${String(snapshot?.limitName ?? '')}`.toLowerCase()
    return label.includes('codex')
  })
  const singleEntry = entries.length === 1 ? entries[0] : undefined
  const snapshot = codexEntry?.[1] ?? singleEntry?.[1] ?? object(root.rateLimits)
  if (!snapshot) return []

  const windows: UsageLimitWindow[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const raw = object(snapshot[key])
    if (!raw) continue
    const durationMinutes = finiteNumber(raw.windowDurationMins)
    const period = windowPeriod(durationMinutes)
    const usedPercent = percent(raw.usedPercent)
    if (!period || usedPercent === undefined || windows.some(window => window.period === period)) continue
    windows.push({
      period,
      usedPercent,
      resetsAt: timestamp(raw.resetsAt),
      durationMinutes: durationMinutes ?? null,
    })
  }
  return windows.sort((a, b) => a.period === 'five-hour' ? -1 : b.period === 'five-hour' ? 1 : 0)
}

/** Parse Claude Code's OAuth usage response (subscription plans only). */
export function parseClaudeCodeUsageLimits(value: unknown): UsageLimitWindow[] {
  const root = object(value)
  if (!root) return []
  const windows: UsageLimitWindow[] = []
  for (const [field, period, durationMinutes] of [
    ['five_hour', 'five-hour', 300],
    ['seven_day', 'weekly', 10_080],
  ] as const) {
    const raw = object(root[field])
    const usedPercent = percent(raw?.utilization, true)
    if (!raw || usedPercent === undefined) continue
    windows.push({
      period,
      usedPercent,
      resetsAt: timestamp(raw.resets_at),
      durationMinutes,
    })
  }
  return windows
}

function emptyProvider(provider: UsageLimitProviderReport['provider'], status: UsageLimitProviderReport['status'], message: string): UsageLimitProviderReport {
  return { provider, status, windows: [], message }
}

async function readClaudeCodeUsage(): Promise<UsageLimitProviderReport> {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
  let credentials: unknown
  try {
    credentials = JSON.parse(await readFile(path.join(configDirectory, '.credentials.json'), 'utf8')) as unknown
  } catch (error) {
    if (object(error)?.code === 'ENOENT') {
      return emptyProvider('claude-code', 'unavailable', '未检测到 Claude Code 登录凭证')
    }
    throw error
  }

  const accessToken = object(object(credentials)?.claudeAiOauth)?.accessToken
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return emptyProvider('claude-code', 'unavailable', '当前 Claude Code 凭证不支持订阅用量查询')
  }

  let response: Response
  try {
    response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Claude Code 用量服务暂时无法连接')
  }

  if (response.status === 401 || response.status === 403) {
    return emptyProvider('claude-code', 'error', 'Claude Code 登录凭证已失效，请先在本机重新登录')
  }
  if (response.status === 429) {
    return emptyProvider('claude-code', 'error', 'Claude Code 用量接口限流，请稍后自动重试')
  }
  if (!response.ok) {
    return emptyProvider('claude-code', 'error', `Claude Code 用量服务暂不可用（HTTP ${response.status}）`)
  }

  const windows = parseClaudeCodeUsageLimits(await response.json().catch(() => undefined))
  return windows.length > 0
    ? { provider: 'claude-code', status: 'available', windows }
    : emptyProvider('claude-code', 'unavailable', '该账户类型或当前计划未提供 5 小时 / 周额度数据')
}

async function readCodexUsage(): Promise<UsageLimitProviderReport> {
  const response = await requestCodexRateLimits()
  const windows = parseCodexUsageLimits(response)
  return windows.length > 0
    ? { provider: 'codex', status: 'available', windows }
    : emptyProvider('codex', 'unavailable', 'Codex 当前未返回 5 小时 / 周额度窗口')
}

function requestCodexRateLimits(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: process.env,
    })
    const lines = createInterface({ input: child.stdout })
    let settled = false
    let requestSent = false

    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      lines.close()
      if (!child.stdin.destroyed) child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      if (error) reject(error)
      else resolve(result)
    }

    const timeout = setTimeout(() => finish(new Error('Codex app-server timed out')), PROVIDER_TIMEOUT_MS)
    timeout.unref?.()

    child.once('error', () => finish(new Error('Codex CLI could not be started')))
    child.once('close', code => {
      if (!settled) finish(new Error(`Codex app-server exited before returning usage (code ${code ?? 'unknown'})`))
    })

    lines.on('line', line => {
      let message: Record<string, unknown> | undefined
      try {
        message = object(JSON.parse(line) as unknown)
      } catch {
        return
      }
      if (!message) return

      if (message.id === 0) {
        if (message.error) {
          finish(new Error('Codex app-server initialization failed'))
          return
        }
        if (!requestSent) {
          requestSent = true
          try {
            child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
            child.stdin.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 1, params: { excludeResetCreditDetails: true } })}\n`)
          } catch {
            finish(new Error('Codex app-server request failed'))
          }
        }
        return
      }

      if (message.id === 1) {
        if (message.error) finish(new Error('Codex app-server could not read usage limits'))
        else finish(undefined, message.result)
      }
    })

    try {
      child.stdin.write(`${JSON.stringify({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: { name: 'pi_dashboard_usage', title: 'Pi Dashboard Usage', version: '1.0.0' },
        },
      })}\n`)
    } catch {
      finish(new Error('Codex app-server initialization request failed'))
    }
  })
}

export class UsageLimitsService {
  private cached?: UsageLimitsReport
  private pending?: Promise<UsageLimitsReport>

  constructor(
    private readonly readers: UsageLimitReaders = { codex: readCodexUsage, claudeCode: readClaudeCodeUsage },
    private readonly cacheTtlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  getReport(): Promise<UsageLimitsReport> {
    if (this.cached && this.now() - this.cached.checkedAt < this.cacheTtlMs) return Promise.resolve(this.cached)
    if (this.pending) return this.pending

    this.pending = Promise.all([
      this.readProvider('codex', this.readers.codex, '无法读取 Codex 额度；请确认本机 Codex CLI 已登录并可运行'),
      this.readProvider('claude-code', this.readers.claudeCode, '无法读取 Claude Code 额度；请确认本机已登录'),
    ]).then(providers => {
      const report = { checkedAt: this.now(), providers }
      this.cached = report
      return report
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async readProvider(
    provider: UsageLimitProviderReport['provider'],
    reader: () => Promise<UsageLimitProviderReport>,
    fallbackMessage: string,
  ): Promise<UsageLimitProviderReport> {
    try {
      return await reader()
    } catch {
      return emptyProvider(provider, 'error', fallbackMessage)
    }
  }
}
