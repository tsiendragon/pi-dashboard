import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LiveSessionGroup, LiveSessionMeta, LiveSessionSummary } from '@shared/live-sessions'
import LiveSessionsList from '../features/live-sessions/LiveSessionsList'

type Call = { url: string; method: string; body: unknown }

function session(processInstanceId: string, pid: number, over: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId,
    sessionId: `session-${processInstanceId}`,
    pid,
    cwd: `/mnt/workspace/lilong/repos/app-${pid}`,
    canonicalCwd: `/mnt/workspace/lilong/repos/app-${pid}`,
    mode: 'tui',
    status: 'idle',
    claim: { state: 'unclaimed' },
    startedAt: pid,
    lastActivityAt: Date.now() - pid * 60_000,
    revision: 1,
    eventSequence: 0,
    ...over,
  }
}

/** Route-mocked fetch for the live-session REST surface; records every call. */
function mockFetch(initial: { groups?: LiveSessionGroup[]; meta?: Record<string, LiveSessionMeta>; order?: string[] } = {}) {
  const calls: Call[] = []
  let groups = initial.groups || []
  let meta = initial.meta || {}
  let order = initial.order || []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })

    if (url === '/api/live-session-groups' && method === 'GET') return ok({ groups })
    if (url === '/api/live-session-order' && method === 'GET') return ok({ order })
    if (url === '/api/live-session-order' && method === 'PUT') {
      order = Array.isArray((body as { order?: unknown })?.order) ? (body as { order: string[] }).order : []
      return ok({ ok: true, order })
    }
    if (url === '/api/live-session-meta' && method === 'GET') return ok({ meta })
    if (method === 'PATCH' && url.startsWith('/api/live-sessions/') && url.endsWith('/meta')) {
      const sessionId = `session-${url.split('/')[3]}`
      const prev = meta[sessionId] || { tags: [], pinned: false, updatedAt: '' }
      meta = { ...meta, [sessionId]: { ...prev, ...(body as object), updatedAt: new Date().toISOString() } }
      return ok({ ok: true, meta: meta[sessionId], all: meta })
    }
    if (url === '/api/live-session-groups' && method === 'POST') {
      groups = [...groups, { id: 'g-new', name: String(body?.name), sessionIds: [], createdAt: '', updatedAt: '' }]
      return ok({ ok: true, groups })
    }
    if (url === '/api/live-sessions/start' && method === 'POST') {
      return ok({ ok: true, result: { slotKey: 'fork', cwd: String(body?.cwd), title: String(body?.title), processInstanceId: 'pi-fork', sessionId: 'session-pi-fork', tmuxSession: 'pi-dash-live-xxxxxxxx' } })
    }
    if (url.endsWith('/members') && method === 'POST') {
      const sessionId = `session-${body?.processInstanceId}`
      groups = groups.map(g => (g.id === url.split('/')[3] ? { ...g, sessionIds: [...new Set([...g.sessionIds, sessionId])] } : g))
      return ok({ ok: true, groups })
    }
    if (url.includes('/members/') && method === 'DELETE') {
      const sessionId = decodeURIComponent(url.split('/members/')[1])
      groups = groups.map(g => (g.id === url.split('/')[3] ? { ...g, sessionIds: g.sessionIds.filter(id => id !== sessionId) } : g))
      return ok({ ok: true, groups })
    }
    if (url.startsWith('/api/live-session-groups/') && method === 'DELETE') {
      groups = groups.filter(g => g.id !== url.split('/')[3])
      return ok({ ok: true, groups })
    }
    if (url.startsWith('/api/pty/sessions/') && method === 'DELETE') return ok({ ok: true })
    if (url.startsWith('/api/path-complete')) {
      return ok({ dir: '/mnt/workspace/lilong/repos', prefix: '', entries: [{ name: 'pi-dashboard', path: '/mnt/workspace/lilong/repos/pi-dashboard', isDir: true }] })
    }
    if (url.includes('/commands') && method === 'POST') return ok({ ok: true, result: {} })
    if (url === '/api/live-sessions/reload' && method === 'POST') return ok({ ok: true, result: { reloaded: ['pid-a', 'pid-b'], skipped: ['pid-child'], failed: [] } })
    return ok({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, groups: () => groups, meta: () => meta, order: () => order }
}

const menuFor = (title: string) => {
  const row = screen.getByText(title).closest('[role="button"]') as HTMLElement
  fireEvent.click(row.querySelector('[aria-label="Session menu"]') as HTMLElement)
}

describe('LiveSessionsList sidebar', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('shows the animated working hammer plus the text label and relative time', () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101, { status: 'running' })]} onSelect={() => {}} />)
    expect(screen.getByText('pi 101')).toBeInTheDocument()
    expect(within(screen.getByRole('status', { name: 'Session 状态：工作中' })).getByTestId('working-hammer')).toBeInTheDocument()
    expect(screen.getByText('工作中')).toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument()   // lastActivityAt = now - 101min
  })

  it.each([['idle', '等待输入'], ['reconnecting', '重连中']] as const)(
    'maps status %s to its own glyph and the %s label', (status, label) => {
      mockFetch()
      render(<LiveSessionsList sessions={[session('pid-a', 101, { status })]} onSelect={() => {}} />)
      const glyph = screen.getByRole('status', { name: `Session 状态：${label}` })
      expect(glyph).toHaveAttribute('data-session-status', status)
      // idle renders a quiet dot, reconnecting a spinner; neither is a text glyph
      expect(glyph.querySelector('svg') ? true : glyph.querySelector('span[aria-hidden]')).toBeTruthy()
      expect(screen.getByText(label)).toBeInTheDocument()
    })

  it('hoists pinned sessions into a leading 置顶 section', async () => {
    mockFetch({ meta: { 'session-pid-b': { tags: [], pinned: true, updatedAt: '' } } })
    const { container } = render(
      <LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />,
    )
    await waitFor(() => expect(screen.getAllByText('pi 102')).toHaveLength(1))
    const headers = [...container.querySelectorAll('section > div:first-child strong')].map(el => el.textContent)
    expect(headers[0]).toBe('置顶')
    expect(headers).toContain('未分组')
    // the pinned row must appear exactly once (not duplicated in 未分组)
    expect(screen.getAllByText('pi 102')).toHaveLength(1)
  })

  it('pins from the ⋯ menu and persists through the meta endpoint', async () => {
    const { calls, meta } = mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    menuFor('pi 101')
    fireEvent.click(await screen.findByText('📌 置顶'))
  })

  it('adds a tag by completion, then filters the list by another tag', async () => {
    const { meta } = mockFetch({ meta: { 'session-pid-b': { tags: ['ocr', 'forgery'], pinned: false, updatedAt: '' } } })
    render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('#forgery · 1 个 session')).toBeInTheDocument())

    // add 'ocr' to pi 101 through the completion list
    menuFor('pi 101')
    fireEvent.click(await screen.findByText('🏷 标签'))
    const input = screen.getByLabelText('Add tag')
    fireEvent.change(input, { target: { value: 'oc' } })
    // The suggestion lives inside the editor; a bare getAllByText would also hit
    // the rail chip and the other row's chip.
    const editor = input.parentElement!.parentElement!
    fireEvent.mouseDown(within(editor as HTMLElement).getByText('ocr') as HTMLElement)
    await waitFor(() => expect(meta()['session-pid-a'].tags).toEqual(['ocr']))
    // editor stays open so more tags can be added (mousedown suppresses blur)
    expect(screen.getByLabelText('Add tag')).toBeInTheDocument()

    // filtering by a tag only pi 102 carries hides pi 101
    fireEvent.click(screen.getByTitle('#forgery · 1 个 session'))
    expect(screen.getByText('pi 102')).toBeInTheDocument()
    expect(screen.queryByText('pi 101')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('全部'))
    expect(screen.getByText('pi 101')).toBeInTheDocument()
  })

  it('searches across title, directory and tags', async () => {
    mockFetch({ meta: { 'session-pid-b': { tags: ['forgery'], pinned: false, updatedAt: '' } } })
    render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('#forgery · 1 个 session')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('搜索 session / 目录 / 标签…'), { target: { value: 'forgery' } })
    expect(screen.getByText('pi 102')).toBeInTheDocument()
    expect(screen.queryByText('pi 101')).not.toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('搜索 session / 目录 / 标签…'), { target: { value: 'app-101' } })
    expect(screen.getByText('pi 101')).toBeInTheDocument()
    expect(screen.queryByText('pi 102')).not.toBeInTheDocument()
  })

  it('joins a task group from the row menu', async () => {
    const groups: LiveSessionGroup[] = [{ id: 'g1', name: '任务A', sessionIds: [], createdAt: '', updatedAt: '' }]
    const { calls } = mockFetch({ groups })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    menuFor('pi 101')
    fireEvent.click(await screen.findByText('→ 加入「任务A」'))
    await waitFor(() => expect(calls.some(c => c.url === '/api/live-session-groups/g1/members' && c.method === 'POST')).toBe(true))
  })

  it('forks a session into a new independent Pi, inheriting its task group and sitting right after it', async () => {
    const groups: LiveSessionGroup[] = [{ id: 'g1', name: '任务A', sessionIds: ['session-pid-a'], createdAt: '', updatedAt: '' }]
    const { calls, order } = mockFetch({ groups })
    render(
      <LiveSessionsList
        sessions={[session('pid-a', 101, { sessionFile: '/x/parent.jsonl' }), session('pid-b', 102)]}
        onSelect={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByText('pi 102')).toBeInTheDocument())
    menuFor('pi 101')
    fireEvent.click(await screen.findByText('⑂ 从此分叉'))
    // pi is launched with --fork against the source session file
    await waitFor(() => expect(calls.some(c => c.url === '/api/live-sessions/start' && c.method === 'POST' && (c.body as { forkFrom?: string }).forkFrom === '/x/parent.jsonl')).toBe(true))
    // the fork joins the source's task group
    await waitFor(() => expect(calls.some(c => c.url === '/api/live-session-groups/g1/members' && c.method === 'POST' && (c.body as { processInstanceId?: string }).processInstanceId === 'pi-fork')).toBe(true))
    // and is ordered directly behind its source
    await waitFor(() => expect(order()).toEqual(['session-pid-a', 'session-pi-fork', 'session-pid-b']))
  })

  it('requires two clicks to delete a task group', async () => {
    const groups: LiveSessionGroup[] = [{ id: 'g1', name: '任务A', sessionIds: ['session-pid-a'], createdAt: '', updatedAt: '' }]
    const { calls, groups: current } = mockFetch({ groups })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('删除任务分组')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('删除任务分组'))
    expect(current()).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('删除任务分组'))
    await waitFor(() => expect(calls.some(c => c.url === '/api/live-session-groups/g1' && c.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(current()).toHaveLength(0))
  })

  it('renames through the ⋯ menu via set_session_name', async () => {
    const { calls } = mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    menuFor('pi 101')
    fireEvent.click(await screen.findByText('✎ 重命名'))
    const input = screen.getByLabelText('重命名 Live session')
    fireEvent.change(input, { target: { value: '冷启动分析' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/commands') && JSON.stringify(c.body) === JSON.stringify({ command: { type: 'set_session_name', name: '冷启动分析' } }))).toBe(true))
  })

  // ---- manual order (docs/live-session-sidebar-order-plan.md) ---------------

  const renderedOrder = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-live-row]')].map(el => el.getAttribute('data-live-row'))

  it('renders the stored manual order instead of startedAt', async () => {
    mockFetch({ order: ['session-pid-b', 'session-pid-a'] })
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(renderedOrder(container)).toEqual(['session-pid-b', 'session-pid-a']))
  })

  it('keeps sessions that were never moved at the tail of their block', async () => {
    mockFetch({ order: ['session-pid-c'] })
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102), session('pid-c', 103)]} onSelect={() => {}} />)
    await waitFor(() => expect(renderedOrder(container)).toEqual(['session-pid-c', 'session-pid-a', 'session-pid-b']))
  })

  it('moves a row up through the ⋯ menu and persists the whole order', async () => {
    const { calls, order } = mockFetch()
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 102')).toBeInTheDocument())
    menuFor('pi 102')
    fireEvent.click(await screen.findByText('↑ 上移'))
    await waitFor(() => expect(order()).toEqual(['session-pid-b', 'session-pid-a']))
    expect(renderedOrder(container)).toEqual(['session-pid-b', 'session-pid-a'])
    expect(calls.some(c => c.url === '/api/live-session-order' && c.method === 'PUT')).toBe(true)
  })

  it('moves a row to the top of its block, and hides boundary moves', async () => {
    const { order } = mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 102')).toBeInTheDocument())

    // the first row cannot move up
    menuFor('pi 101')
    expect(screen.queryByText('↑ 上移')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    menuFor('pi 102')
    fireEvent.click(await screen.findByText(/移到本组顶部/))
    await waitFor(() => expect(order()).toEqual(['session-pid-b', 'session-pid-a']))
  })

  it('restores automatic ordering from the footer', async () => {
    const { calls, order } = mockFetch({ order: ['session-pid-b', 'session-pid-a'] })
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(renderedOrder(container)).toEqual(['session-pid-b', 'session-pid-a']))
    fireEvent.click(screen.getByText('恢复自动排序'))
    await waitFor(() => expect(order()).toEqual([]))
    await waitFor(() => expect(renderedOrder(container)).toEqual(['session-pid-a', 'session-pid-b']))
    expect(calls.filter(c => c.url === '/api/live-session-order' && c.method === 'PUT')).toHaveLength(1)
  })

  it('renders a task group block above 未分组 and keeps membership edits working', async () => {
    const groups: LiveSessionGroup[] = [{ id: 'g1', name: '任务A', sessionIds: ['session-pid-b'], createdAt: '', updatedAt: '' }]
    const { groups: currentGroups } = mockFetch({ groups })
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('任务分组：任务A')).toBeInTheDocument())
    await waitFor(() => expect(renderedOrder(container)).toEqual(['session-pid-b', 'session-pid-a']))

    menuFor('pi 102')
    fireEvent.click(await screen.findByText(/\u21e4 移出「任务A」/))
    await waitFor(() => expect(currentGroups()[0].sessionIds).toEqual([]))
  })

  it('re-reads order, groups and meta when the same Pi switches session in place (/clear)', async () => {
    const { calls } = mockFetch({ order: ['session-pid-a', 'session-pid-b'] })
    const { rerender } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())
    // order / meta / groups are all keyed by pi sessionId, so all three are re-read
    const reads = () => calls.filter(c => c.method === 'GET' && c.url.startsWith('/api/live-session-')).length
    const before = reads()
    expect(before).toBe(3)

    rerender(<LiveSessionsList sessions={[session('pid-a', 101, { sessionId: 'session-cleared' }), session('pid-b', 102)]} onSelect={() => {}} />)
    await waitFor(() => expect(reads()).toBe(before + 3))
  })

  // ---- start form (cwd input) ---------------------------------------------

  it('opens the start form with a hint about valid cwds, and completes directories on Tab', async () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    const input = screen.getByPlaceholderText(/工作目录/)
    expect(screen.getByText(/必须是/)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '/mnt/workspace/lilong/' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    // the completion is portaled; the directory entry is what the user picks
    await waitFor(() => expect(screen.getByText(/pi-dashboard\//)).toBeInTheDocument())
  })

  // ---- tmux-first live sessions -------------------------------------------

  it('marks a tmux-hosted session as terminal-reachable and copies the attach command', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockFetch({ meta: { 'session-pid-a': { tags: [], pinned: false, tmux: 'pi-dash-live-abcd1234', updatedAt: '' } } })

    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('终端可访问：tmux attach -t pi-dash-live-abcd1234')).toBeInTheDocument())

    menuFor('pi 101')
    fireEvent.click(await screen.findByText('⧉ 复制终端命令'))
    expect(writeText).toHaveBeenCalledWith('tmux attach -t pi-dash-live-abcd1234')
  })

  it('closes a session by killing its tmux session, after a confirmation', async () => {
    const { calls } = mockFetch({ meta: { 'session-pid-a': { tags: [], pinned: false, tmux: 'pi-dash-live-abcd1234', updatedAt: '' } } })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('终端可访问：tmux attach -t pi-dash-live-abcd1234')).toBeInTheDocument())

    menuFor('pi 101')
    fireEvent.click(await screen.findByText('⏻ 关闭 session（kill tmux）'))
    // first click only arms the destructive action
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)

    fireEvent.click(await screen.findByText('再点一次确认关闭'))
    await waitFor(() => expect(calls.some(c => c.url === '/api/pty/sessions/pi-dash-live-abcd1234' && c.method === 'DELETE')).toBe(true))
  })

  it('hides the terminal affordances for sessions started outside the dashboard', async () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())
    menuFor('pi 101')
    expect(screen.queryByText(/复制终端命令/)).not.toBeInTheDocument()
    expect(screen.queryByText('⏻ 关闭 session（kill tmux）')).not.toBeInTheDocument()
  })

  it('reloads every main session in one click, after a confirmation', async () => {
    const { calls } = mockFetch()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-child', 202, { role: 'subagent' })]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '重载全部' }))
    // The subagent row is left out of the count: the backend skips child processes.
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('1 个会话'))
    await waitFor(() => expect(calls.some(c => c.url === '/api/live-sessions/reload' && c.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.getByRole('status', { name: '重载结果' })).toHaveTextContent('已重载 2 个会话，跳过 1 个子 Agent'))
  })

  it('does not reload when the confirmation is declined', async () => {
    const { calls } = mockFetch()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '重载全部' }))
    expect(calls.some(c => c.url === '/api/live-sessions/reload')).toBe(false)
  })
})
