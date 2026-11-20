import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LiveSessionFeatures from '../features/live-sessions/LiveSessionFeatures'
import { projectProofJobs, proofJobTiming } from '../features/live-sessions/proofJobs'

type Props = Parameters<typeof LiveSessionFeatures>[0]

function renderFeatures(features: Record<string, unknown>) {
  const props: Props = {
    features, cwd: '/repo', status: 'idle',
    onFileOpen: vi.fn(), onOpenBtw: vi.fn(), onCloseBtw: vi.fn(), onBtwSubmit: vi.fn(), onBtwAbort: vi.fn(),
    onBtwRefreshParent: vi.fn(), onOpenWorkflow: vi.fn(), onGoalSync: vi.fn(), onCompact: vi.fn(), onClear: vi.fn(),
    onReload: vi.fn(), onAbort: vi.fn(),
  }
  return render(<LiveSessionFeatures {...props} />)
}

describe('proof-jobs projection', () => {
  it('is absent until the session publishes the feature', () => {
    expect(projectProofJobs(undefined)).toBeUndefined()
    expect(projectProofJobs({ tasks: 'nope' })).toBeUndefined()
    expect(projectProofJobs({ tasks: [] })).toEqual({ jobs: [], active: 0 })
  })

  it('validates entries, orders live jobs first and counts queued + running', () => {
    const projection = projectProofJobs({ tasks: [
      { id: 'pj-done', label: 'Lemma 2', state: 'finished', createdAt: 1_000, startedAt: 2_000, finishedAt: 62_000 },
      { id: 'pj-q', label: 'Lemma 3', state: 'queued', createdAt: 5_000 },
      { id: 'pj-run', label: 'Lemma 1', state: 'running', createdAt: 1_000, startedAt: 3_000 },
      { id: 'pj-odd', state: 'cancelling', startedAt: 'yesterday' },
      { id: 'pj-run', label: 'duplicate', state: 'failed' },
      { label: 'no id', state: 'running' },
      null,
    ] })!
    expect(projection.jobs.map(job => job.id)).toEqual(['pj-run', 'pj-q', 'pj-done', 'pj-odd'])
    expect(projection.active).toBe(2)
    expect(projection.jobs[3]).toMatchObject({ label: 'pj-odd', state: 'unknown', startedAt: undefined })
    expect(projection.jobs[2].collected).toBeUndefined()
    expect(proofJobTiming(projection.jobs[0], 93_000)).toBe('已运行 1m 30s')
    expect(proofJobTiming(projection.jobs[1], 15_000)).toBe('已排队 10s')
    expect(proofJobTiming(projection.jobs[2], 0)).toBe('用时 1m')
  })
})

describe('Proof jobs rail panel', () => {
  it('stays hidden for sessions without PiMatrix proof jobs', () => {
    renderFeatures({})
    expect(screen.queryByLabelText('Proof jobs')).not.toBeInTheDocument()
  })

  it('lists jobs read-only with an active-count badge', () => {
    renderFeatures({ 'proof-jobs': { tasks: [
      { id: 'pj-1', label: 'Prove trace inequality', state: 'running', createdAt: Date.now() - 5_000, startedAt: Date.now() - 4_000 },
      { id: 'pj-2', label: 'Review lemma', state: 'failed', createdAt: 1, finishedAt: 2 },
      { id: 'pj-3', label: 'Solve', state: 'finished', finishedAt: 3, collected: true },
    ] } })
    const rail = screen.getByLabelText('Proof jobs')
    expect(within(rail).getByText('1')).toBeInTheDocument()
    const panel = within(rail.closest('details') as HTMLElement)
    expect(panel.getByText('Prove trace inequality')).toBeInTheDocument()
    expect(panel.getByText('运行中')).toBeInTheDocument()
    expect(panel.getByText('失败')).toBeInTheDocument()
    expect(panel.getByText('已取回')).toBeInTheDocument()
    expect(panel.queryAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['收起Proof jobs'])
  })
})
