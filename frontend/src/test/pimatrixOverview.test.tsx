import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidatePimatrixCache } from '../../../plugins/pi-matrix/src/api'
import { ProofOverviewPage } from '../../../plugins/pi-matrix/src/overview'

const ROOT = '/tmp/pimatrix-demo'

const summary = {
  root: ROOT,
  id: 'pimatrix-demo',
  title: 'Demo project',
  targets: [{ id: 'T', status: 'open', tier: 'conjecture', aligned: false }],
  ledger: { events: 1, head: 'sha256:abc', chain_ok: true },
  reviewRule: { passes_required: 3, families_required: 2 },
  lowYield: { flag: false, events_since_progress: 1, window: 12 },
  warnings: ['alignment pending'],
  claims: { total: 1, byTier: { conjecture: 1 } },
  updatedAt: new Date().toISOString(),
}

const status = {
  project: 'pimatrix-demo',
  ledger: { events: 1, head: 'sha256:abc', chain_ok: true },
  review_rule: { passes_required: 3, families_required: 2 },
  targets: [{ id: 'T', status: 'open', tier: 'conjecture', aligned: false, refines: null, statement: 'Every gadget is fine.' }],
  claims: [{
    id: 'T',
    kind: 'target',
    tier: 'conjecture',
    closed: false,
    cycle: false,
    refines: null,
    has_formal: false,
    routes: [],
    flags: [],
    statement: 'Every gadget is fine.',
  }],
  low_yield: { flag: false, events_since_progress: 1, window: 12 },
  warnings: ['alignment pending'],
}

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

beforeEach(() => {
  invalidatePimatrixCache()
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    const url = String(input)
    if (url.startsWith('/api/pimatrix/projects')) return json({ ok: true, projects: [summary], roots: ['/tmp'], kernel: { packageRoot: '/pkg', python: 'python3' }, generatedAt: '' })
    if (url.startsWith('/api/pimatrix/status')) return json({ ok: true, status, meta: { root: ROOT, readAt: new Date().toISOString(), stale: false } })
    if (url.startsWith('/api/pimatrix/log')) return json({ ok: true, events: [{ seq: 0, ts: new Date().toISOString(), type: 'claim_registered', claim: 'T', summary: 'registered target T' }], meta: { root: ROOT } })
    return json({ ok: false, error: `unexpected ${url}`, code: 'unexpected' })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProofOverviewPage', () => {
  it('lists projects and expands one into kernel status + ledger', async () => {
    render(<ProofOverviewPage onClose={() => {}} />)
    const title = await screen.findByText('Demo project')
    expect(screen.getByText('1 project(s)')).toBeTruthy()
    expect(screen.getByText('open 1')).toBeTruthy()
    fireEvent.click(title.closest('[role="button"]')!)
    await waitFor(() => expect(screen.getByText('ledger timeline')).toBeTruthy())
    expect(screen.getByText('registered target T')).toBeTruthy()
    expect(screen.getByText('alignment pending')).toBeTruthy()
  })
})
