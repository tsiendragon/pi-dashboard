import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import MemoryPage from '../pages/MemoryPage'

const overview = {
  available: true,
  databasePath: '/home/u/.pi/tsien-memory/memory.db',
  updatedAt: Date.now(),
  counts: { active: 21, candidate: 37, stale: 0, superseded: 2, rejected: 15, forgotten: 291, total: 366 },
  review: { total: 37, conflicts: 1, unverified: 36, scopeEscalation: 2 },
  usage: { recallRuns: 11748, recallCandidates: 14187, contextInjected: 120, verified: 0, corrected: 49, lastActivityAt: Date.now() },
  health: { pendingIndexJobs: 0, failedIndexJobs: 0, lastEventAt: Date.now() },
  selfManagement: { autoAccepted: 4, agentCreated: 349, userDecided: 19, rejectedByAgent: 0 },
}

const candidate = {
  id: 'm2',
  kind: 'decision',
  status: 'candidate',
  scopeType: 'repository',
  scopeKey: 'repository:r',
  content: 'deploy from the release branch',
  confidence: 0.68,
  version: 1,
  observedCount: 1,
  appliedCount: 0,
  verifiedCount: 0,
  correctedCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  conflicts: 1,
  source: { authority: 'verified_tool', verified: true, sourceType: 'tool_result', sourceUri: 'tool:shell' },
}

const responses: Record<string, unknown> = {
  '/api/memory/overview': overview,
  '/api/memory/items': { items: [{ ...candidate, id: 'm1', status: 'active', conflicts: 0, content: 'use pnpm for installs' }] },
  '/api/memory/review': { items: [candidate] },
  '/api/memory/changes': { changes: [{ id: 'e1', memoryId: 'm1', eventType: 'status_changed', toStatus: 'active', actor: 'system', reasonCode: 'evidence_backed', createdAt: Date.now(), contentPreview: 'use pnpm for installs' }] },
  '/api/memory/promotions': {
    proposals: [
      { id: 'p1', memoryId: 'm1', suggestedType: 'skill', status: 'proposed', strength: '中', content: '先在两个仓库复现再升级', createdAt: Date.now() },
      { id: 'p2', memoryId: 'm2', suggestedType: 'rule', status: 'proposed', strength: '弱', content: '提交前先跑类型检查', createdAt: Date.now() },
    ],
  },
  '/api/memory/nightly': { available: true, generatedAt: new Date().toISOString(), windowDays: 30, markdown: '# 记忆夜间总结\n\n20 条记忆值得考虑沉淀。' },
  '/api/memory/usage': { windowDays: 7, recallRuns: 2036, recallCandidates: 2404, contextInjected: 90, verified: 0, averageLatencyMs: 11, topUsed: [{ id: 'm1', content: 'use pnpm for installs', injected: 5, verified: 0 }] },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(responses).find((path) => String(url).startsWith(path))
    if (!key) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(responses[key]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MemoryPage', () => {
  it('shows what the agent remembers and what is waiting for a human', async () => {
    render(<MemoryPage />)
    expect(await screen.findByText('生效记忆')).toBeInTheDocument()
    expect(await screen.findByText('21')).toBeInTheDocument()
    expect(screen.getByText('37')).toBeInTheDocument()
    expect(screen.getByText(/冲突 1/)).toBeInTheDocument()
  })

  it('says plainly when verification is still missing instead of claiming a win', async () => {
    render(<MemoryPage />)
    expect(await screen.findByText('尚无验证闭环')).toBeInTheDocument()
  })

  it('explains why a candidate needs the user in the review tab', async () => {
    render(<MemoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: /待确认/ }))
    expect(await screen.findByText(/需要你确认：与 1 条现有记忆冲突/)).toBeInTheDocument()
  })

  it('separates recall candidates from what actually reached the model', async () => {
    render(<MemoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: '使用与效果' }))
    expect(await screen.findByText('检索候选条数')).toBeInTheDocument()
    expect(screen.getByText('实际入模条数')).toBeInTheDocument()
    expect(screen.getByText(/“检索候选”只说明被找到/)).toBeInTheDocument()
  })

  it('asks for the live-session credential instead of showing an empty page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'authentication_required' }), { status: 401 })))
    render(<MemoryPage />)
    await waitFor(() => expect(screen.getByText(/完成一次认证/)).toBeInTheDocument())
  })

  it('surfaces the nightly review and its suggestions without claiming they are done', async () => {
    render(<MemoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: '升级建议' }))
    expect(await screen.findByText(/最近一次自动总结/)).toBeInTheDocument()
    expect(await screen.findByText('先在两个仓库复现再升级')).toBeInTheDocument()
    expect(screen.getByText('证据中')).toBeInTheDocument()
    expect(screen.getByText('证据弱')).toBeInTheDocument()
    expect(screen.getByText(/不会自己改记忆/)).toBeInTheDocument()
  })

  it('says the nightly job has not run instead of showing an empty report', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/memory/nightly')) return new Response(JSON.stringify({ available: false }), { status: 200 })
      if (String(url).startsWith('/api/memory/promotions')) return new Response(JSON.stringify({ proposals: [] }), { status: 200 })
      return new Response(JSON.stringify(responses['/api/memory/overview']), { status: 200 })
    }))
    render(<MemoryPage />)
    fireEvent.click(await screen.findByRole('button', { name: '升级建议' }))
    expect(await screen.findByText(/夜里还没有跑过总结/)).toBeInTheDocument()
  })
})