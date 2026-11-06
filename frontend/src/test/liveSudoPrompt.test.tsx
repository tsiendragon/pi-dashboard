import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import LiveSessionExtensionUiModal from '../features/live-sessions/LiveSessionExtensionUiModal'
import liveSessionsReducer from '../store/liveSessionsSlice'
import { createTestStore, renderWithProviders } from './helpers'

const command = vi.fn().mockResolvedValue({ accepted: true })
vi.mock('../features/live-sessions/api', () => ({ liveSessionApi: { command: (...args: unknown[]) => command(...args) } }))

describe('sudo prompt Web fallback', () => {
  it('shows exact command and machine, never asks for a password, and uses dedicated cancellation', async () => {
    const store = createTestStore({ liveSessions: {
      ...liveSessionsReducer(undefined, { type: '@@INIT' }),
      pendingUi: { p: { s: { id: 's', method: 'sudo', title: '管理员授权', host: 'machine-fixture', cwd: '/tmp', command: '["/usr/bin/id","-u"]', expiresAt: Date.now() + 60000 } } },
    } })
    renderWithProviders(<LiveSessionExtensionUiModal processInstanceId="p" />, { store })
    expect(screen.getByText(/machine-fixture/)).toBeInTheDocument()
    expect(screen.getByText('["/usr/bin/id","-u"]')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消本次授权' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith('p', { type: 'answer_sudo', id: 's', cancelled: true }))
  })
})
