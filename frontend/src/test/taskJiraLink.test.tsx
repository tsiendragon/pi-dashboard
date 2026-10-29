import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import TaskDetailPage from '../pages/tasks/TaskDetail'
import type { TaskFact } from '@shared/tasks.js'
import { createTestStore, renderWithProviders } from './helpers'

vi.mock('../pages/tasks/EventTimeline', () => ({ EventTimeline: () => <div data-testid="timeline" /> }))

function task(over: Partial<TaskFact> = {}): TaskFact {
  return {
    uid: 'task-journal:PROJ-1',
    providerId: 'task-journal',
    id: 'PROJ-1',
    kind: 'epic',
    title: 'A tracked epic',
    completion: 'doing',
    archived: false,
    plannable: true,
    tags: [],
    writable: false,
    sourceLabel: 'Task Journal',
    ...over,
  }
}

function renderTask(over: Partial<TaskFact> = {}) {
  return renderWithProviders(
    <TaskDetailPage
      task={task(over)}
      entry={undefined}
      sessions={[]}
      lanes={[]}
      planning={{}}
      authReady={false}
      liveOptions={[]}
      onClose={() => {}}
      onUpdate={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onStart={() => {}}
      onOpenSession={() => {}}
    />,
    { store: createTestStore() },
  )
}

describe('task jira link', () => {
  it('opens the ticket in a new tab when the task carries a Jira key', () => {
    renderTask({ jiraKey: 'PROJ-1', jiraUrl: 'https://example.atlassian.net/browse/PROJ-1' })
    const link = screen.getByRole('link', { name: /PROJ-1/ })
    expect(link).toHaveAttribute('href', 'https://example.atlassian.net/browse/PROJ-1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('shows no Jira row for an untracked task', () => {
    renderTask()
    expect(screen.queryByRole('link', { name: /Jira|PROJ-1/ })).toBeNull()
  })

  it('shows the cached Jira status and flags a ticket that is ahead of the journal', () => {
    renderTask({
      kind: 'task',
      completion: 'doing',
      jiraKey: 'PROJ-1',
      jiraUrl: 'https://example.atlassian.net/browse/PROJ-1',
      jiraStatus: { name: 'Done', category: 'done', assignee: 'Ada Lovelace', priority: 'Medium', readAt: new Date().toISOString() },
      stage: { done: 2, total: 4, active: 'stage_2_pull' },
    })
    expect(screen.getByText(/状态不一致/)).toBeInTheDocument()
    expect(screen.getByText(/Jira 已完成，本地未关/)).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument()
    expect(screen.getByText(/阶段 2\/4/)).toBeInTheDocument()
  })
})