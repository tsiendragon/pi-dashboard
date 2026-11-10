import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { RootState } from '../store'
import liveSessionsReducer from '../store/liveSessionsSlice'
import LiveSessionExtensionUiModal from '../features/live-sessions/LiveSessionExtensionUiModal'
import { createTestStore, renderWithProviders } from './helpers'

vi.mock('../features/live-sessions/api', () => ({ liveSessionApi: { command: vi.fn() } }))

function state(): RootState {
  const live = liveSessionsReducer(undefined, { type: '@@INIT' })
  return {
    dashboard: {}, chat: {}, notifications: {},
    liveSessions: {
      ...live,
      auth: 'authenticated',
      sessions: {},
      pendingUi: {
        p1: { c1: { id: 'c1', method: 'confirm', title: '打开会话里的确认' } },
        p2: { c2: { id: 'c2', method: 'confirm', title: '另一个会话的确认' } },
      },
    },
  } as unknown as RootState
}

describe('extension UI corner stack', () => {
  it('leaves confirmations of the open conversation to its in-place card', () => {
    renderWithProviders(<LiveSessionExtensionUiModal />, { store: createTestStore(state()), route: '/live-sessions/p1' })
    expect(screen.queryByText('打开会话里的确认')).not.toBeInTheDocument()
    // Another session's prompt must stay reachable from wherever the user is.
    expect(screen.getByText('另一个会话的确认')).toBeInTheDocument()
  })

  it('still surfaces every confirmation when no conversation is open', () => {
    renderWithProviders(<LiveSessionExtensionUiModal />, { store: createTestStore(state()), route: '/' })
    expect(screen.getByText('打开会话里的确认')).toBeInTheDocument()
    expect(screen.getByText('另一个会话的确认')).toBeInTheDocument()
  })
})