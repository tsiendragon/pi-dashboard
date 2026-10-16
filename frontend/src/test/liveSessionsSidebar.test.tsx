import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LiveSessionGroup, LiveSessionMeta, LiveSessionSummary, RepoCandidate } from '@shared/live-sessions'
import LiveSessionsList from '../features/live-sessions/LiveSessionsList'

type Call = { url: string; method: string; body: unknown }

function session(processInstanceId: string, pid: number, over: Partial<LiveSessionSummary> = {}): LiveSessionSummary {
  return {
    processInstanceId,
    sessionId: `session-${processInstanceId}`,
    pid,
    cwd: `~/repos/app-${pid}`,
    canonicalCwd: `~/repos/app-${pid}`,
    mode: 'tui',
    capabilities: ['session_shutdown'],
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
function mockFetch(initial: { groups?: LiveSessionGroup[]; meta?: Record<string, LiveSessionMeta>; order?: string[]; sectionOrder?: string[]; repos?: RepoCandidate[] } = {}) {
  const calls: Call[] = []
  let groups = initial.groups || []
  let meta = initial.meta || {}
  let order = initial.order || []
  let sectionOrder = initial.sectionOrder || []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const ok = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })

    if (url === '/api/live-session-groups' && method === 'GET') return ok({ groups })
    if (url === '/api/live-sessions/repo-candidates' && method === 'GET') return ok({ repos: initial.repos || [] })
    if (url === '/api/live-session-order' && method === 'GET') return ok({ order, sectionOrder })
    if (url === '/api/live-session-order' && method === 'PUT') {
      if (Array.isArray(body?.sectionOrder)) sectionOrder = body.sectionOrder
      else order = Array.isArray(body?.order) ? body.order : []
      return ok({ ok: true, order, sectionOrder })
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
    if (url.startsWith('/api/live-sessions/') && url.endsWith('/restart') && method === 'POST') {
      return ok({ ok: true, result: { processInstanceId: 'pid-a-restarted', sessionId: 'session-pid-a', tmuxSession: 'pi-dash-live-restarted' } })
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
    if (url.startsWith('/api/live-session-groups/') && url.endsWith('/merge') && method === 'POST') {
      const sourceId = url.split('/')[3]
      const source = groups.find(g => g.id === sourceId)
      groups = groups
        .filter(g => g.id !== sourceId)
        .map(g => (g.id === body?.targetId ? { ...g, sessionIds: [...new Set([...g.sessionIds, ...(source?.sessionIds || [])])] } : g))
      return ok({ ok: true, groups })
    }
    if (url.startsWith('/api/pty/sessions/') && method === 'DELETE') return ok({ ok: true })
    if (url.startsWith('/api/path-complete')) {
      return ok({ dir: '~/workspace/repos', prefix: '', entries: [{ name: 'pi-dashboard', path: '~/repos/pi-dashboard', isDir: true }] })
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
  beforeEach(() => { vi.restoreAllMocks(); window.localStorage.clear() })

  it('puts Hold last, defaults it to collapsed, and reveals search matches', async () => {
    mockFetch({ groups: [
      { id: 'hold', name: 'Hold', sessionIds: ['session-pid-b'], createdAt: '', updatedAt: '' },
      { id: 'work', name: '进行中', sessionIds: ['session-pid-a'], createdAt: '', updatedAt: '' },
    ] })
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102), session('pid-c', 103)]} onSelect={() => {}} />)
    await screen.findByRole('button', { name: 'Hold：展开分组' })
    expect([...container.querySelectorAll('section[data-live-block]')].map(section => section.getAttribute('data-live-block'))).toEqual(['work', '__ungrouped', 'hold'])
    expect(screen.queryByText('pi 102')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hold：展开分组' }))
    expect(screen.getByText('pi 102')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hold：折叠分组' }))
    fireEvent.change(screen.getByPlaceholderText('搜索 session / 目录 / 标签…'), { target: { value: 'pi 102' } })
    expect(screen.getByText('pi 102')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hold：折叠分组' }))
    expect(screen.queryByText('pi 102')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hold：展开分组' }))
    expect(screen.getByText('pi 102')).toBeInTheDocument()
  })

  it('saves group order, including ungrouped, and reloads it without changing row order', async () => {
    const { calls } = mockFetch({ groups: [{ id: 'work', name: '进行中', sessionIds: ['session-pid-a'], createdAt: '', updatedAt: '' }], order: ['session-pid-a', 'session-pid-b'] })
    const sessions = [session('pid-a', 101), session('pid-b', 102)]
    const { container, unmount } = render(<LiveSessionsList sessions={sessions} onSelect={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /任务$/ }))
    const move = await screen.findByRole('button', { name: '进行中：移到底部' })
    fireEvent.click(move)
    await waitFor(() => expect(calls.some(call => call.url === '/api/live-session-order' && call.method === 'PUT' && JSON.stringify(call.body) === JSON.stringify({ sectionOrder: ['__ungrouped', 'work'] }))).toBe(true))
    expect([...container.querySelectorAll('section[data-live-block]')].map(section => section.getAttribute('data-live-block'))).toEqual(['__ungrouped', 'work'])
    unmount()
    const reloaded = render(<LiveSessionsList sessions={sessions} onSelect={() => {}} />)
    await waitFor(() => expect([...reloaded.container.querySelectorAll('section[data-live-block]')].map(section => section.getAttribute('data-live-block'))).toEqual(['__ungrouped', 'work']))
  })

  it('does not allow overlapping group-order writes while a save is pending', async () => {
    const { calls } = mockFetch({ groups: [{ id: 'work', name: '进行中', sessionIds: ['session-pid-a'], createdAt: '', updatedAt: '' }] })
    const originalFetch = globalThis.fetch
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(init.body).includes('sectionOrder')) await waiting
      return originalFetch(url, init)
    })
    render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /任务$/ }))
    fireEvent.click(await screen.findByRole('button', { name: '进行中：移到底部' }))
    const reverse = screen.getByRole('button', { name: '进行中：上移分组' })
    expect(reverse).toBeDisabled()
    fireEvent.click(reverse)
    release()
    await waitFor(() => expect(reverse).toBeEnabled())
    expect(calls.filter(call => call.url === '/api/live-session-order' && call.method === 'PUT')).toHaveLength(1)
  })

  it('restarts one eligible session after two-click confirmation and selects its replacement', async () => {
    const { calls } = mockFetch({ meta: { 'session-pid-a': { tags: [], pinned: false, tmux: 'pi-dash-live-abc12345', updatedAt: '' } } })
    const onSelect = vi.fn()
    render(<LiveSessionsList sessions={[session('pid-a', 101, { sessionFile: '/tmp/session-a.jsonl', capabilities: [] })]} activeId="pid-a" onSelect={onSelect} />)

    const restart = screen.getByLabelText('重启 session pi 101')
    await waitFor(() => expect(restart).toBeEnabled())
    fireEvent.click(restart)
    expect(calls.some(call => call.url === '/api/live-sessions/pid-a/restart')).toBe(false)
    fireEvent.click(restart)

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('pid-a-restarted'))
    expect(calls.some(call => call.url === '/api/live-sessions/pid-a/restart' && call.method === 'POST')).toBe(true)
    await waitFor(() => expect(screen.getByLabelText('会话操作结果')).toHaveTextContent('已重启'))
  })

  it('disables restart for sessions not managed by the dashboard', () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101, { sessionFile: '/tmp/session-a.jsonl', capabilities: ['session_shutdown'] })]} onSelect={() => {}} />)
    expect(screen.getByLabelText('重启 session pi 101')).toBeDisabled()
  })

  it('shows the animated working muyu without a redundant status label', () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101, { status: 'running' })]} onSelect={() => {}} />)
    expect(screen.getByText('pi 101')).toBeInTheDocument()
    expect(screen.getByText('pi 101').closest('[data-live-row]')).toHaveClass('py-1')
    expect(within(screen.getByRole('status', { name: 'Session 状态：工作中' })).getByTestId('working-muyu')).toBeInTheDocument()
    expect(screen.queryByText('工作中')).not.toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument()// lastActivityAt = now - 101min
  })

  it.each([['idle', '等待输入'], ['reconnecting', '重连中']] as const)(
    'maps status %s to its own glyph without the redundant %s label', (status, label) => {
      mockFetch()
      render(<LiveSessionsList sessions={[session('pid-a', 101, { status })]} onSelect={() => {}} />)
      const glyph = screen.getByRole('status', { name: `Session 状态：${label}` })
      expect(glyph).toHaveAttribute('data-session-status', status)
      // idle renders a quiet dot, reconnecting a spinner; neither is a text glyph
      expect(glyph.querySelector('svg') ? true : glyph.querySelector('span[aria-hidden]')).toBeTruthy()
      expect(screen.queryByText(label)).not.toBeInTheDocument()
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
    fireEvent.click(await screen.findByRole('menuitem', { name: '📌 置顶' }))
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

  it('moves a session through the group submenu and includes groups beyond the first six', async () => {
    const groups: LiveSessionGroup[] = Array.from({ length: 8 }, (_, i) => ({
      id: `g${i + 1}`, name: `任务${String.fromCharCode(65 + i)}`, sessionIds: [], createdAt: '', updatedAt: '',
    }))
    const { calls } = mockFetch({ groups })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    menuFor('pi 101')
    fireEvent.click(await screen.findByRole('menuitem', { name: '移动到分组' }))
    expect(screen.getByRole('menuitem', { name: '→ 加入「任务H」' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: '→ 加入「任务A」' }))
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

  it('lists empty duplicate groups and merges one into the other from the admin panel', async () => {
    const groups: LiveSessionGroup[] = [
      { id: 'g1', name: 'hold', sessionIds: ['session-pid-a'], createdAt: '', updatedAt: '' },
      { id: 'g2', name: 'hold', sessionIds: [], createdAt: '', updatedAt: '' },
    ]
    const { calls, groups: current } = mockFetch({ groups })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)

    fireEvent.click(screen.getByTitle('新建 / 管理任务分组'))
    // The empty duplicate has no sidebar section, so this panel is the only place it shows up.
    expect(await screen.findByTitle('0 个 session')).toBeInTheDocument()

    fireEvent.click(screen.getAllByLabelText('合并分组 hold')[1])
    fireEvent.change(screen.getByLabelText('合并 hold 到'), { target: { value: 'g1' } })
    fireEvent.click(screen.getByText('确认合并'))

    await waitFor(() => expect(calls.some(c => c.url === '/api/live-session-groups/g2/merge' && c.method === 'POST' && (c.body as { targetId?: string }).targetId === 'g1')).toBe(true))
    await waitFor(() => expect(current()).toHaveLength(1))
    expect(current()[0].sessionIds).toEqual(['session-pid-a'])
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
    fireEvent.click(await screen.findByRole('menuitem', { name: '↑ 上移' }))
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
    expect(screen.queryByRole('menuitem', { name: '↑ 上移' })).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })

    menuFor('pi 102')
    fireEvent.click(await screen.findByRole('menuitem', { name: '⤒ 移到本组顶部' }))
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
    const { groups: currentGroups } = mockFetch({ groups, meta: { 'session-pid-b': { tags: ['demo-tag'], updatedAt: '' } } })
    const { container } = render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-b', 102)]} onSelect={() => {}} />)
    await screen.findByRole('button', { name: '任务A：折叠分组' })
    const row = container.querySelector('[data-live-row="session-pid-b"]') as HTMLElement
    expect(within(row).queryByText('任务A')).not.toBeInTheDocument()
    expect(screen.queryByTitle('任务分组：任务A')).not.toBeInTheDocument()
    expect(within(row).getByText('demo-tag')).toBeInTheDocument()
    await waitFor(() => expect(renderedOrder(container)).toEqual(['session-pid-b', 'session-pid-a']))

    menuFor('pi 102')
    fireEvent.click(await screen.findByRole('menuitem', { name: '移动到分组' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /移出「任务A」/ }))
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

  it('starts in a selected group with tags and remembers the working directory', async () => {
    const group: LiveSessionGroup = { id: 'g1', name: 'ai-tools', sessionIds: [], createdAt: '', updatedAt: '' }
    const { calls } = mockFetch({ groups: [group] })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    fireEvent.click(screen.getByRole('button', { name: '~/repos/app-101' }))
    fireEvent.change(screen.getByRole('combobox', { name: '启动后加入分组' }), { target: { value: 'g1' } })
    fireEvent.change(screen.getByPlaceholderText('标签（可选，逗号分隔）'), { target: { value: 'review, urgent' } })
    fireEvent.click(within(screen.getByText('启动 Live Pi').closest('form')!).getByRole('button', { name: '启动' }))

    await waitFor(() => expect(calls.some(call => call.url === '/api/live-session-groups/g1/members' && call.method === 'POST')).toBe(true))
    expect(calls.some(call => call.url === '/api/live-sessions/pi-fork/meta' && call.method === 'PATCH' && JSON.stringify(call.body) === JSON.stringify({ tags: ['review', 'urgent'] }))).toBe(true)
    expect(window.localStorage.getItem('pi-dashboard:live-session-start-paths')).toBe(JSON.stringify(['~/repos/app-101']))
  })

  it('opens the start form with a hint about valid cwds, and completes directories on Tab', async () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    const input = screen.getByPlaceholderText(/工作目录/)
    expect(screen.getByText(/必须是/)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '~/workspace/' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    // the completion is portaled; the directory entry is what the user picks
    await waitFor(() => expect(screen.getByText(/pi-dashboard\//)).toBeInTheDocument())
  })

  it('matches a remembered directory by keyword, and Tab fills the only hit in', async () => {
    window.localStorage.setItem('pi-dashboard:live-session-start-paths', JSON.stringify(['~/repos/toolkit', '~/repos/task-journal']))
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    const input = screen.getByPlaceholderText(/工作目录/) as HTMLInputElement

    fireEvent.change(input, { target: { value: 'toolkit' } })
    // The suggestion row follows the keyword instead of the newest paths.
    expect(screen.getByRole('button', { name: '~/repos/toolkit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '~/repos/task-journal' })).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('~/repos/toolkit/')
  })

  it('lists every keyword hit in the Tab menu and replaces the field with the picked one', async () => {
    window.localStorage.setItem('pi-dashboard:live-session-start-paths', JSON.stringify(['~/repos/toolkit', '~/repos/toolkit-wt']))
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    const input = screen.getByPlaceholderText(/工作目录/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'toolkit' } })
    fireEvent.keyDown(input, { key: 'Tab' })

    // Two hits: nothing is filled in silently, the menu offers both.
    expect(input.value).toBe('toolkit')
    const menu = await screen.findByRole('listbox', { name: '目录补全' })
    const row = within(menu).getByText('~/repos/toolkit-wt')
    fireEvent.mouseDown(row.closest('button')!)
    expect(input.value).toBe('~/repos/toolkit-wt/')
  })

  it('searches repos under the configured repo roots by keyword and fills a unique hit', async () => {
    mockFetch({
      repos: [
        { name: 'sample-toolkit', path: '/srv/repos/sample-toolkit', git: true },
        { name: 'pi-dashboard', path: '/srv/repos/pi-dashboard', git: true },
      ],
    })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    const input = screen.getByPlaceholderText(/工作目录/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'toolkit' } })

    // A repo never opened before is still offered, by name alone.
    expect(await screen.findByRole('button', { name: '/srv/repos/sample-toolkit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '/srv/repos/pi-dashboard' })).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('/srv/repos/sample-toolkit/')
  })

  it('labels repo hits in the Tab menu separately from used directories', async () => {
    window.localStorage.setItem('pi-dashboard:live-session-start-paths', JSON.stringify(['/srv/repos/sample-ai-dev']))
    mockFetch({
      repos: [
        { name: 'sample-viz', path: '/srv/repos/sample-viz', git: true },
        { name: 'sample-ai-dev', path: '/srv/repos/sample-ai-dev', git: true },
      ],
    })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('启动一个新的 Live Pi'))
    const input = screen.getByPlaceholderText(/工作目录/) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sample' } })

    // Wait for the repo list to arrive so the keyword has two hits (history + repo).
    expect(await screen.findByRole('button', { name: '/srv/repos/sample-viz' })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Tab' })

    const menu = await screen.findByRole('listbox', { name: '目录补全' })
    const repoRow = within(menu).getByText('/srv/repos/sample-viz').closest('button')!
    expect(within(repoRow).getByText('仓库目录')).toBeInTheDocument()
    // A path already in history stays a history row instead of a second repo row.
    const historyRow = within(menu).getByText('/srv/repos/sample-ai-dev').closest('button')!
    expect(within(historyRow).getByText('用过的目录')).toBeInTheDocument()
    expect(within(menu).getAllByText('/srv/repos/sample-ai-dev')).toHaveLength(1)
  })

  // ---- tmux-first live sessions -------------------------------------------

  it('marks a tmux-hosted session as terminal-reachable and copies the attach command', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockFetch({ meta: { 'session-pid-a': { tags: [], pinned: false, tmux: 'pi-dash-live-abcd1234', updatedAt: '' } } })

    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('终端可访问：tmux attach -t pi-dash-live-abcd1234')).toBeInTheDocument())
    // The tmux name lives in the ⋯ menu, not on the row.
    expect(screen.queryByText('pi-dash-live-abcd1234')).not.toBeInTheDocument()

    menuFor('pi 101')
    fireEvent.click(await screen.findByRole('menuitem', { name: '⧉ 复制终端命令' }))
    expect(writeText).toHaveBeenCalledWith('tmux attach -t pi-dash-live-abcd1234')

    // The read-only tmux block shows the session name and copies from its own row too.
    menuFor('pi 101')
    const tmuxRow = await screen.findByRole('menuitem', { name: /pi-dash-live-abcd1234/ })
    expect(tmuxRow).toHaveTextContent('⧉ 复制 attach 命令')
    fireEvent.click(tmuxRow)
    expect(writeText).toHaveBeenCalledWith('tmux attach -t pi-dash-live-abcd1234')
  })

  it('closes a session by killing its tmux session, after a confirmation', async () => {
    const { calls } = mockFetch({ meta: { 'session-pid-a': { tags: [], pinned: false, tmux: 'pi-dash-live-abcd1234', updatedAt: '' } } })
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByTitle('终端可访问：tmux attach -t pi-dash-live-abcd1234')).toBeInTheDocument())

    menuFor('pi 101')
    fireEvent.click(await screen.findByRole('menuitem', { name: '⏻ 关闭 session（kill tmux）' }))
    // first click only arms the destructive action
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)

    fireEvent.click(await screen.findByRole('menuitem', { name: '确认关闭' }))
    await waitFor(() => expect(calls.some(c => c.url === '/api/pty/sessions/pi-dash-live-abcd1234' && c.method === 'DELETE')).toBe(true))
  })

  it('hides the terminal affordances for sessions started outside the dashboard', async () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())
    menuFor('pi 101')
    expect(screen.queryByRole('menuitem', { name: '⧉ 复制终端命令' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '⏻ 关闭 session（kill tmux）' })).not.toBeInTheDocument()
    expect(screen.queryByText(/tmux 会话/)).not.toBeInTheDocument()
  })

  it('uses the dedicated shutdown command from any session row after confirmation', async () => {
    const { calls } = mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    const exitButton = screen.getByRole('button', { name: '退出 session pi 101' })

    fireEvent.click(exitButton)
    expect(calls.some(call => call.url.endsWith('/commands'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '确认退出 session pi 101' }))
    await waitFor(() => expect(calls.some(call =>
      call.url === '/api/live-sessions/pid-a/commands'
      && call.method === 'POST'
      && JSON.stringify(call.body) === JSON.stringify({ command: { type: 'shutdown' } }),
    )).toBe(true))
    await waitFor(() => expect(screen.getByLabelText('会话操作结果')).toHaveTextContent('已发送退出指令'))
    expect(calls.some(call => call.url.startsWith('/api/pty/sessions/'))).toBe(false)
  })

  it('nests a child under its main session and reveals the selected child', async () => {
    mockFetch()
    const parent = session('pid-a', 101)
    const child = session('pid-child', 202, { role: 'subagent', parentSessionId: parent.sessionId })
    const { container } = render(<LiveSessionsList sessions={[parent, child]} sessionTitles={{ 'pid-child': '子助手检查' }} activeId="pid-child" onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())
    const childRow = screen.getByText('子助手检查').closest('[role="button"]')
    const details = childRow?.closest('details')
    expect(details?.open).toBe(true)
    expect(details?.querySelector('summary')).toHaveTextContent('子助手 · 1')
    expect(container.querySelector('[aria-label="未关联子助手"]')).toBeNull()
  })

  it('keeps an orphan child accessible instead of hiding it from the sidebar', async () => {
    mockFetch()
    render(<LiveSessionsList sessions={[session('pid-child', 202, { role: 'subagent', parentSessionId: 'missing-parent' })]} sessionTitles={{ 'pid-child': '离线父会话的子助手' }} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('离线父会话的子助手')).toBeInTheDocument())
    expect(screen.getByRole('region', { name: '未关联子助手' })).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的 session')).toBeNull()
  })

  // window.confirm is answered with a silent `false` when the browser suppresses
  // dialogs, so the rail asks for a second click instead of a dialog.
  it('reloads every main session after an in-page confirmation', async () => {
    const { calls } = mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101), session('pid-child', 202, { role: 'subagent' })]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '重载全部' }))
    // The subagent row is left out of the count: the backend skips child processes.
    expect(screen.getByRole('status', { name: '重载结果' })).toHaveTextContent('再点一次「重载全部」确认：1 个主会话')
    expect(calls.some(c => c.url === '/api/live-sessions/reload')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '确认重载' }))
    await waitFor(() => expect(calls.some(c => c.url === '/api/live-sessions/reload' && c.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.getByRole('status', { name: '重载结果' })).toHaveTextContent('已重载 2 个会话，跳过 1 个子 Agent'))
  })

  it('does not reload until the second click lands', async () => {
    const { calls } = mockFetch()
    render(<LiveSessionsList sessions={[session('pid-a', 101)]} onSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('pi 101')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '重载全部' }))
    expect(calls.some(c => c.url === '/api/live-sessions/reload')).toBe(false)
  })
})
