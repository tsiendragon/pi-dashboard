import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { RootState } from '../store'
import liveSessionsReducer from '../store/liveSessionsSlice'
import { createTestStore, renderWithProviders } from './helpers'
import { PendingConfirmationBadge, PendingConfirmations } from '../features/supervisor/PendingConfirmations'

const command = vi.fn()
vi.mock('../features/live-sessions/api', () => ({
  liveSessionApi: { command: (...args: unknown[]) => command(...args) },
  LiveSessionApiError: class LiveSessionApiError extends Error {},
}))

const MESSAGE = [
  '当前消息未明确授权这项操作，请核对目标与内容：',
  '{"operation":"record"}',
  '[supervisor-confirm]{"op":"record","ref":"task-journal:eu-fake-id-service","sum":"记录 EU Fake-ID 项目起点"}',
].join('\n')

function state(): RootState {
  const live = liveSessionsReducer(undefined, { type: '@@INIT' })
  return {
    dashboard: {} as RootState['dashboard'],
    chat: {} as RootState['chat'],
    notifications: {} as RootState['notifications'],
    liveSessions: {
      ...live,
      auth: 'authenticated',
      sessions: {
        'process-main': {
          processInstanceId: 'process-main', sessionId: 's-main', pid: 101, cwd: '~/repos/pi-dashboard', canonicalCwd: '~/repos/pi-dashboard',
          sessionName: '主会话', mode: 'tui', status: 'idle', claim: { state: 'unclaimed' },
          startedAt: 1, lastActivityAt: 2, revision: 1, eventSequence: 0,
        },
      },
      pendingUi: {
        'process-main': {
          'ui-record': { id: 'ui-record', method: 'confirm', title: '主 Agent 操作确认', message: MESSAGE },
          'ui-plain': { id: 'ui-plain', method: 'confirm', title: '别的确认', message: '没有目标对象的确认' },
        },
      },
    },
  } as RootState
}

beforeEach(() => { command.mockReset(); command.mockResolvedValue({ ok: true, result: null }) })

describe('pending confirmations', () => {
  it('renders the pending write on the page that owns the object', () => {
    renderWithProviders(<PendingConfirmations objectRef="task-journal:eu-fake-id-service" />, { store: createTestStore(state()) })
    expect(screen.getByText(/记录 EU Fake-ID 项目起点/)).toBeInTheDocument()
    expect(screen.getByText(/来自「主会话」/)).toBeInTheDocument()
    // The machine trailer is never shown as body text.
    expect(screen.queryByText(/\[supervisor-confirm\]/)).not.toBeInTheDocument()
  })

  it('stays out of pages for other objects and for untargeted requests', () => {
    const store = createTestStore(state())
    const { container } = renderWithProviders(<PendingConfirmations objectRef="local:other" />, { store })
    expect(container).toBeEmptyDOMElement()
  })

  it('approves through the live-session command and drops the card', async () => {
    const store = createTestStore(state())
    renderWithProviders(<PendingConfirmations objectRef="task-journal:eu-fake-id-service" />, { store })
    fireEvent.click(screen.getByRole('button', { name: '允许这次操作' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith('process-main', { type: 'answer_ui', id: 'ui-record', value: 'true' }))
    await waitFor(() => expect(screen.queryByText(/记录 EU Fake-ID 项目起点/)).not.toBeInTheDocument())
  })

  it('counts targeted writes in the sidebar badge and can deny from there', async () => {
    const store = createTestStore(state())
    renderWithProviders(<PendingConfirmationBadge />, { store })
    fireEvent.click(screen.getByRole('button', { name: /1 项待确认/ }))
    expect(screen.getByRole('heading', { name: '待确认的主 Agent 写入' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '不允许' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith('process-main', { type: 'answer_ui', id: 'ui-record', cancelled: true }))
  })

  it('opens the sidebar list in a portal so a scroll container cannot clip its buttons', () => {
    const store = createTestStore(state())
    const { container } = renderWithProviders(<PendingConfirmationBadge />, { store })
    fireEvent.click(screen.getByRole('button', { name: /1 项待确认/ }))
    // Rendered outside the render root: the sidebar's overflow can no longer cut off the
    // approve/deny buttons that used to live past its right edge.
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许这次操作' })).toBeInTheDocument()
  })

  it('hides the badge when nothing is pending', () => {
    const empty = state()
    empty.liveSessions = { ...empty.liveSessions, pendingUi: {} }
    const { container } = renderWithProviders(<PendingConfirmationBadge />, { store: createTestStore(empty) })
    expect(container).toBeEmptyDOMElement()
  })
})