import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import LiveSessionFeatures from '../features/live-sessions/LiveSessionFeatures'

describe('LiveSessionFeatures', () => {
  it('renders BTW, scheduler, subagent and workflow snapshots', () => {
    render(<LiveSessionFeatures onOpenBtw={() => {}} onCloseBtw={() => {}} features={{
      btw: { status: 'ready', conversation: [{ role: 'assistant', text: 'side answer' }] },
      schedule: { tasks: [{ id: 'schedule-1', title: 'Check job', instruction: 'Inspect output', nextRunAt: Date.now() + 60_000 }] },
      'subagent-workflow': {
        conversations: { items: [{ id: 'work-1', label: 'Scout', status: 'running' }] },
        workflows: { items: [{ id: 'workflow-1', label: 'Benchmark', status: 'running' }] },
      },
    }} />)

    expect(screen.getByText('BTW · 1')).toBeInTheDocument()
    expect(screen.getByText('Scheduler · 1')).toBeInTheDocument()
    expect(screen.getByText('Subagent / Workflow · 2')).toBeInTheDocument()
  })
})
