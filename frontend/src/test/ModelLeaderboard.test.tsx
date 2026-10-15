import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import ModelLeaderboard from '../pages/ModelLeaderboard'
import { MODEL_SCORES } from '../data/modelScores'

function usageReport(models: Array<{ key: string; costUsd: number; totalTokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>) {
  return {
    month: '2026-10',
    timezone: 'UTC',
    currency: 'USD' as const,
    total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0 },
    daily: [],
    sessions: [],
    recordCount: 0,
    models: models.map(m => ({
      key: m.key,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadTokens: m.cacheReadTokens,
      cacheWriteTokens: 0,
      totalTokens: m.totalTokens,
      costUsd: m.costUsd,
      inputCostUsd: m.costUsd / 2,
      outputCostUsd: m.costUsd / 2,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      effectiveUsdPerMillionTokens: m.totalTokens > 0 ? (m.costUsd / m.totalTokens) * 1e6 : 0,
    })),
  }
}

function timingReport(models: Array<{ key: string; tokensPerSec: number; outputTokens: number }>) {
  return {
    range: 'month' as const,
    month: '2026-10',
    total: { activeMs: 0, childActiveMs: 0, modelMs: 0, toolMs: 0, overheadMs: 0, modelCalls: 0, toolCalls: 0, outputTokens: 0, errors: 0, runs: 0, childRuns: 0, ttftCalls: 0, ttftMs: 0, thinkingCalls: 0, thinkingMs: 0, decodeMs: 0 },
    daily: [],
    models: models.map(m => ({
      key: m.key,
      provider: m.key.split('/')[0],
      model: m.key.split('/')[1] ?? '',
      calls: 1,
      errors: 0,
      totalMs: 1000,
      avgTotalMs: 1000,
      ttftCalls: 1,
      ttftAvgMs: 500,
      ttftP50Ms: 500,
      ttftP90Ms: 800,
      outputTokens: m.outputTokens,
      decodeTokensPerSec: m.tokensPerSec,
      thinkingCalls: 0,
      thinkingMs: 0,
      thinkingAvgMs: 0,
      thinkingShare: 0,
    })),
    tools: [],
    sessions: [],
  }
}

describe('ModelLeaderboard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/usage')) {
        return new Response(JSON.stringify(usageReport([
          { key: 'llm-gateway/claude-sonnet-5-5', costUsd: 3, totalTokens: 1_000_000, inputTokens: 900_000, outputTokens: 100_000, cacheReadTokens: 50_000 },
          { key: 'azure-proxy/claude-sonnet-5-5', costUsd: 1, totalTokens: 500_000, inputTokens: 450_000, outputTokens: 50_000, cacheReadTokens: 0 },
        ])), { status: 200 })
      }
      if (url.startsWith('/api/timing')) {
        return new Response(JSON.stringify(timingReport([
          { key: 'llm-gateway/claude-sonnet-5-5', tokensPerSec: 90, outputTokens: 100_000 },
          { key: 'azure-proxy/claude-sonnet-5-5', tokensPerSec: 30, outputTokens: 50_000 },
        ])), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
  })

  it('joins static AA scores with our per-provider usage and speed', async () => {
    render(<ModelLeaderboard />)
    // 等待账本数据完成联表
    const row = await screen.findByText('Claude Sonnet 5.5', { selector: 'div.font-medium' })
    const tr = row.closest('tr')!
    // 两个通道合计：$3 + $1 = $4
    expect(within(tr).getByText('$4.00')).toBeInTheDocument()
    // 加权输出速度：(90*100k + 30*50k) / 150k = 70 tok/s
    expect(within(tr).getByText('70.0 tok/s')).toBeInTheDocument()
    // 实际单价：4 / 1.5M ≈ $2.67/MTok
    expect(within(tr).getByText('$2.67/M')).toBeInTheDocument()
  })

  it('defaults to only our enabled models and can toggle to the full board', async () => {
    render(<ModelLeaderboard />)
    const summary = await screen.findByText(/个模型/)
    expect(summary.textContent).toMatch(/^\d+ 个模型/)
    // 默认只看已启用：没有 muse / gemini 这类未接模型
    expect(screen.queryByText('Muse Wonder Full')).toBeNull()
    // 取消勾选后应出现未接模型
    const toggle = screen.getByLabelText(/只看已启用的模型/) as HTMLInputElement
    toggle.click()
    expect(await screen.findByText('Muse Wonder Full')).toBeInTheDocument()
  })

  it('renders AA scores for models without local usage as dashes', async () => {
    render(<ModelLeaderboard />)
    await screen.findByText(/个模型/)
    const claudeHaiku = MODEL_SCORES.find(m => m.slug === 'claude-haiku-5-5')
    expect(claudeHaiku).toBeDefined()
    // Haiku 未出现在 mock 账本中，花费列应为 —
    const name = await screen.findByText('Claude Haiku 5.5', { selector: 'div.font-medium' })
    const tr = name.closest('tr')!
    const cells = Array.from(tr.querySelectorAll('td'))
    const costCell = cells[cells.length - 4]
    expect(costCell.textContent).toBe('—')
  })
})
