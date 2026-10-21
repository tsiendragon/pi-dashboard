import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { createTestStore } from './helpers'
import CommandPalette from '../components/CommandPalette'
import { api } from '../api/client'

vi.mock('../api/client', () => ({
  api: {
    searchSessions: vi.fn(),
    resumeChatSlot: vi.fn(),
    models: vi.fn().mockResolvedValue({ models: [] }),
    slotSystemPrompt: vi.fn(),
    setSlotModel: vi.fn(),
    setSlotThinking: vi.fn(),
    renameSlot: vi.fn(),
    tagSlot: vi.fn(),
  },
}))

// jsdom lacks matchMedia (useTheme) and scrollIntoView (selected row).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})
Element.prototype.scrollIntoView = vi.fn()

// cmdk's Command.Dialog mounts a ResizeObserver on open; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: ResizeObserverStub })

const session = {
  id: 'sess-1',
  name: 'Earlier conversation',
  file: '/home/u/.pi/agent/sessions/--repo--/sess-1.jsonl',
  cwd: '/repo',
  startedAt: '2026-10-18T10:00:00.000Z',
  projectSlug: '--repo--',
  summary: '',
  userMessageCount: 0,
  assistantMessageCount: 0,
  models: [],
}

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <CommandPalette open={open} onOpenChange={setOpen} onToggleSidebar={() => {}} />
      <button onClick={() => window.dispatchEvent(new CustomEvent('pi-dashboard:open-session-search'))}>resume</button>
    </>
  )
}

describe('CommandPalette — resume a past session', () => {
  beforeEach(() => {
    vi.mocked(api.searchSessions).mockResolvedValue({ results: [session], source: 'scan', indexed: false })
    vi.mocked(api.resumeChatSlot).mockResolvedValue({ ok: true, key: 'chat-9', messages: [], has_more: false, total: 0 })
  })

  it('opens straight into history search and resumes the picked session', async () => {
    const user = userEvent.setup()
    render(
      <Provider store={createTestStore()}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </Provider>,
    )

    // `/resume` in the composer dispatches this event.
    await user.click(screen.getByText('resume'))
    expect(await screen.findByPlaceholderText('Search past sessions…')).toBeInTheDocument()

    await user.click(await screen.findByText('Earlier conversation'))
    await waitFor(() =>
      expect(api.resumeChatSlot).toHaveBeenCalledWith('sess-1', 'Earlier conversation', session.file),
    )
  })
})