import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders, createTestStore } from './helpers'
import ChatSidebar from '../pages/ChatSidebar'
import { api } from '../api/client'

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock child components that are complex
vi.mock('../components/InfoTip', () => ({ default: () => null }))
vi.mock('../components/TypewriterText', () => ({
  default: ({ text, className }: { text: string; className?: string }) => <span className={className}>{text}</span>,
}))

// Mock the chat submodule export
vi.mock('../pages/chat', () => ({
  NotificationItem: ({ n, onOpen, onDelete }: any) => (
    <div data-testid={`notification-${n.ts}`}>{n.title}</div>
  ),
}))

vi.mock('../api/client', () => ({
  api: {
    clearSessions: vi.fn(),
    sessions: vi.fn(),
    chatSlots: vi.fn(),
    chatSlotDetail: vi.fn(),
    chatMode: vi.fn(),
    deleteChatSlot: vi.fn(),
    createChatSlot: vi.fn(),
    resumeChatSlot: vi.fn(),
    deleteSession: vi.fn(),
    pinSlot: vi.fn().mockResolvedValue({ ok: true }),
    renameSlot: vi.fn().mockResolvedValue({ ok: true }),
    tagSlot: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

const baseProps = {
  slots: [
    { key: 'slot-1', title: 'Fix the bug', running: false },
    { key: 'slot-2', title: 'Write tests', running: true },
    { key: 'slot-3', title: 'Deploy', running: false, stopping: true },
  ],
  activeSlot: 'slot-1',
  unreadSlots: ['slot-2'],
}

describe('ChatSidebar', () => {
  it('renders slot list', () => {
    renderWithProviders(<ChatSidebar {...baseProps} />)

    expect(screen.getByText('Fix the bug')).toBeInTheDocument()
    expect(screen.getByText('Write tests')).toBeInTheDocument()
    expect(screen.getByText('Deploy')).toBeInTheDocument()
  })

  it('renders Sessions header', () => {
    renderWithProviders(<ChatSidebar {...baseProps} />)
    expect(screen.getByText('Sessions')).toBeInTheDocument()
  })

  it('renders new chat button', () => {
    renderWithProviders(<ChatSidebar {...baseProps} />)
    expect(screen.getByLabelText('New chat session')).toBeInTheDocument()
  })

  it('renders filter input', () => {
    renderWithProviders(<ChatSidebar {...baseProps} />)
    expect(screen.getByPlaceholderText('Filter sessions…')).toBeInTheDocument()
  })

  it('renders pending approval badge', () => {
    const props = {
      ...baseProps,
      slots: [
        { key: 'slot-1', title: 'Needs approval', running: true, pending_approval: true },
      ],
    }
    renderWithProviders(<ChatSidebar {...props} />)
    expect(screen.getByTitle('Waiting for approval')).toBeInTheDocument()
  })

  it('renders stopping indicator', () => {
    const props = {
      ...baseProps,
      slots: [
        { key: 'slot-3', title: 'Stopping slot', running: false, stopping: true },
      ],
      activeSlot: null,
    }
    renderWithProviders(<ChatSidebar {...props} />)
    expect(screen.getByTitle('Stopping')).toBeInTheDocument()
  })

  it('groups slots by project when cwd differs', () => {
    localStorageMock.getItem.mockImplementation((key: string) => key === 'mc-slots-group-mode' ? 'project' : null)
    const props = {
      ...baseProps,
      slots: [
        { key: 'slot-1', title: 'Fix the bug', running: false, cwd: '/home/user/project-a' },
        { key: 'slot-2', title: 'Write tests', running: false, cwd: '/home/user/project-b' },
      ],
    }
    renderWithProviders(<ChatSidebar {...props} />)
    expect(screen.getByText('project-a')).toBeInTheDocument()
    expect(screen.getByText('project-b')).toBeInTheDocument()
    localStorageMock.getItem.mockReturnValue(null)
  })
})

describe('ChatSidebar — pin, tags, menu', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorageMock.getItem.mockReturnValue(null) })

  const slot = (over: any) => ({ key: 'k', title: 't', running: false, ...over })

  it('hoists pinned slots into a leading Pinned group', () => {
    const props = {
      activeSlot: null, unreadSlots: [],
      slots: [
        slot({ key: 'a', title: 'Fresh unpinned', updated: new Date().toISOString() }),
        slot({ key: 'b', title: 'Old pinned', pinned: true, updated: new Date(Date.now() - 86400000).toISOString() }),
      ],
    }
    const { container } = renderWithProviders(<ChatSidebar {...(props as any)} />)
    expect(screen.getByText('Pinned')).toBeInTheDocument()
    const titles = [...container.querySelectorAll('.pidash-slot-item')].map(el => el.textContent)
    expect(titles[0]).toContain('Old pinned')
    expect(titles[1]).toContain('Fresh unpinned')
  })

  it('pin from the ⋯ menu patches the slot optimistically', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChatSidebar activeSlot={null} unreadSlots={[]} slots={[slot({ key: 's1', title: 'Pin me' })]} />)
    await user.click(screen.getAllByLabelText('Session menu')[0])
    await user.click(await screen.findByText('📌 置顶'))
    expect(api.pinSlot).toHaveBeenCalledWith('s1', true)
  })

  it('hides system tags (job namespace) from chips and the filter rail', () => {
    renderWithProviders(<ChatSidebar activeSlot={null} unreadSlots={[]}
      slots={[slot({ key: 'j', title: 'Job run', tags: ['job:abc', 'job'] })]} />)
    expect(screen.queryByText('job:abc')).not.toBeInTheDocument()
    expect(screen.queryByText('job')).not.toBeInTheDocument()
  })

  it('filters the list when a tag chip is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChatSidebar activeSlot={null} unreadSlots={[]}
      slots={[
        slot({ key: '1', title: 'OCR batch', tags: ['ocr'] }),
        slot({ key: '2', title: 'Router fix', tags: ['router'] }),
      ]} />)
    await user.click(screen.getByTitle('#ocr · 1 个会话'))
    expect(screen.getByText('OCR batch')).toBeInTheDocument()
    expect(screen.queryByText('Router fix')).not.toBeInTheDocument()
    await user.click(screen.getByText('全部'))
    expect(screen.getByText('Router fix')).toBeInTheDocument()
  })

  it('suggests existing tags when adding one', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChatSidebar activeSlot={null} unreadSlots={[]}
      slots={[
        slot({ key: '1', title: 'Has ocr', tags: ['ocr'] }),
        slot({ key: '2', title: 'No tags' }),
      ]} />)
    const row = screen.getByText('No tags').closest('.pidash-slot-item')!
    await user.click(within(row as HTMLElement).getByLabelText('Session menu'))
    await user.click(await screen.findByText('🏷 标签'))
    await user.type(screen.getByLabelText('Add tag'), 'oc')
    // DOM order = rail chip, row chip, then the suggestion → last is the suggestion
    const suggestion = screen.getAllByText('ocr').at(-1)!
    await user.click(suggestion)
    expect(api.tagSlot).toHaveBeenCalledWith('2', ['ocr'])
  })

  it('renames through the ⋯ menu', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChatSidebar activeSlot={null} unreadSlots={[]} slots={[slot({ key: 's9', title: 'Old name' })]} />)
    await user.click(screen.getAllByLabelText('Session menu')[0])
    await user.click(await screen.findByText('✎ 重命名'))
    const input = screen.getByLabelText('Edit session title')
    await user.clear(input)
    await user.type(input, 'New name')
    await user.keyboard('{Enter}')
    expect(api.renameSlot).toHaveBeenCalledWith('s9', 'New name')
  })

  it('requires two clicks to close a session', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ChatSidebar activeSlot={null} unreadSlots={[]} slots={[slot({ key: 's3', title: 'Close me' })]} />)
    await user.click(screen.getAllByLabelText('Session menu')[0])
    await user.click(await screen.findByText('✕ 关闭会话'))
    expect(api.deleteChatSlot).not.toHaveBeenCalled()
    expect(screen.getByText('Close me')).toBeInTheDocument()
    await user.click(screen.getByText('再点一次确认关闭'))
    expect(api.deleteChatSlot).toHaveBeenCalledWith('s3')
  })
})
