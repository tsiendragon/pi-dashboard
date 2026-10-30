import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModelLeaderboard from '../pages/ModelLeaderboard'

const report = (models: any[]) => ({ month: '2026-10', timezone: 'UTC', currency: 'USD',
  total: {}, daily: [], sessions: [], recordCount: 0,
  models: models.map(m => ({ key: m.key, inputTokens: 0, outputTokens: m.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: m.totalTokens ?? 0, costUsd: m.costUsd ?? 0, inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0,
    effectiveUsdPerMillionTokens: 0 })) })

describe('dbg', () => {
  it('dumps row', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      if (url.startsWith('/api/usage')) return new Response(JSON.stringify(report([
        { key: 'llm-gateway/claude-sonnet-5-5', costUsd: 3, totalTokens: 1_000_000, outputTokens: 100_000 },
        { key: 'azure-gateway-claude/claude-sonnet-5-5', costUsd: 1, totalTokens: 500_000, outputTokens: 50_000 },
      ])), { status: 200 })
      if (url.startsWith('/api/timing')) return new Response(JSON.stringify({ range: 'month', month: '2026-10', total: {}, daily: [], tools: [], sessions: [], models: [] }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    render(<ModelLeaderboard />)
    const row = await screen.findByText('Claude Sonnet 5.5', { selector: 'div.font-medium' })
    await new Promise(r => setTimeout(r, 300))
    console.log('ROW:', row.closest('tr')!.textContent)
    expect(true).toBe(true)
  })
})
