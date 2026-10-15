import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithProviders } from './helpers'
import App from '../App'
import { TasksSectionTabs } from '../pages/tasks/TasksSectionTabs'

// Only the two pages under test matter here; everything else stays mocked so routing is the thing being checked.
vi.mock('../pages/TasksPage', () => ({ default: () => <div data-testid="tasks-page">TasksPage</div> }))
vi.mock('../pages/EventLedgerPage', () => ({ default: () => <div data-testid="ledger-page">EventLedgerPage</div> }))
vi.mock('../pages/ChatPage', () => ({ default: () => <div data-testid="chat-page">ChatPage</div> }))
vi.mock('../pages/SystemPage', () => ({ default: () => <div data-testid="system-page">SystemPage</div> }))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribeLogs: () => {} }) }))
vi.mock('../components/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }))
vi.mock('../api/client', () => ({
  api: {
    chatSlots: vi.fn().mockResolvedValue([]),
    notifications: vi.fn().mockResolvedValue({ notifications: [] }),
    status: vi.fn().mockResolvedValue({ uptime: '1h', sessions: 0, messages: 0, cron_jobs: 0, subagents: 0, lessons: 0 }),
  },
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
})

describe('事件流水账作为 Tasks 的下一级', () => {
  it('serves the ledger at /tasks/events', () => {
    renderWithProviders(<App />, { route: '/tasks/events' })
    expect(screen.getByTestId('ledger-page')).toBeInTheDocument()
  })

  it('keeps the previous /events link working and carries the query along', () => {
    renderWithProviders(<App />, { route: '/events?objectRef=journal%3A42' })
    expect(screen.getByTestId('ledger-page')).toBeInTheDocument()
  })

  it('does not let the ledger path open a task detail by accident', () => {
    renderWithProviders(<App />, { route: '/tasks/events' })
    expect(screen.queryByTestId('tasks-page')).not.toBeInTheDocument()
  })

  it('still opens a normal task detail at /tasks/:uid', () => {
    renderWithProviders(<App />, { route: '/tasks/local%3At-383e4c55' })
    expect(screen.getByTestId('tasks-page')).toBeInTheDocument()
  })

  it('keeps the ledger out of the sidebar and the mobile tab bar', () => {
    renderWithProviders(<App />, { route: '/tasks' })
    expect(screen.queryByText('事件流水账')).not.toBeInTheDocument()
  })

  it('reaches the ledger from the switch shared by the Tasks pages', () => {
    render(<MemoryRouter><TasksSectionTabs active="list" /></MemoryRouter>)
    expect(screen.getByRole('tab', { name: '任务清单' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '事件流水账' })).toHaveAttribute('aria-selected', 'false')
  })
})