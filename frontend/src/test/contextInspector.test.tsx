/**
 * 上下文检查器：把「实际发给模型的内容」如实摊开。
 *
 * 这里守住三件容易出错的事：
 * 1. 数据来源必须说清楚 —— 真实请求载荷和近似重建在界面上是两种不同的标签，重建结果
 *    不能被当成事实展示。
 * 2. 旧的 bridge 不认这条命令时给的是可执行的提示（去重载扩展），不是一句「加载失败」。
 * 3. 大块头要能一眼看到：系统提示的组成、工具定义、最大的消息都能读到真实字符数。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionContextView } from '@shared/live-sessions'
import ContextInspector from '../features/live-sessions/ContextInspector'

function view(overrides: Partial<LiveSessionContextView> = {}): LiveSessionContextView {
  return {
    version: 1,
    source: 'provider_request',
    format: 'openai-responses',
    generatedAt: 1_700_000_000_000,
    capturedAt: 1_699_999_000_000,
    model: { provider: 'test', id: 'model' },
    system: { text: 'You are an expert coding assistant.\n\nGuidelines:\n- Be concise', chars: 55, tokens: 20 },
    systemParts: [
      { kind: 'context_file', label: '/repo/AGENTS.md', chars: 40, tokens: 18 },
      { kind: 'base', label: '基础提示', chars: 15, tokens: 2 },
    ],
    tools: [{ name: 'read', description: 'Read a file', descriptionChars: 11, parameters: '{"type":"object"}', parametersChars: 17, tokens: 8 }],
    messages: [
      { index: 0, kind: 'message', category: 'user', role: 'user', label: 'user', text: 'hello there', chars: 11, tokens: 3 },
      { index: 1, kind: 'tool_result', category: 'tool_result', role: 'tool', label: '工具结果', text: 'x'.repeat(1200), chars: 1200, tokens: 300, truncated: true },
    ],
    totals: { tokens: 331, chars: 1283, byCategory: { system: 20, tools: 8, user: 3, assistant: 0, tool_call: 0, tool_result: 300, reasoning: 0, other: 0 } },
    contextUsage: { tokens: 340, contextWindow: 200_000, percent: 0.17 },
    settings: { model: '"test"', reasoning: '{"effort":"medium"}' },
    truncated: false,
    ...overrides,
  }
}

function mockFetch(body: unknown, status = 200) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }))
  return calls
}

afterEach(() => { vi.restoreAllMocks() })

describe('ContextInspector', () => {
  it('把真实载荷标成「真实请求」并列出各类别的占比', async () => {
    mockFetch({ ok: true, result: view() })
    render(<ContextInspector processInstanceId="process-a" sessionLabel="任务 A" onClose={() => {}} />)

    expect(await screen.findByText('上下文检查')).toBeInTheDocument()
    expect(screen.getByText('真实请求')).toBeInTheDocument()
    // 类别图例给出估算 token 与占比，最大的那一类（工具结果 300）排在最前。
    const legend = screen.getAllByText('工具结果').map(node => node.parentElement as HTMLElement)[0]
    expect(legend.textContent).toContain('300')
    expect(screen.getByText('331 tokens')).toBeInTheDocument()
  })

  it('重建的视图必须标注为「近似重建」', async () => {
    mockFetch({ ok: true, result: view({ source: 'reconstructed', capturedAt: undefined, contextUsage: undefined }) })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    expect(await screen.findByText('近似重建')).toBeInTheDocument()
    expect(screen.queryByText('真实请求')).not.toBeInTheDocument()
  })

  it('系统提示标签页按块给出字符数，并能读到正文', async () => {
    mockFetch({ ok: true, result: view() })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /系统提示/ }))

    expect(screen.getByText('/repo/AGENTS.md')).toBeInTheDocument()
    expect(screen.getByText('基础提示')).toBeInTheDocument()
    expect(screen.getByText(/Guidelines/)).toBeInTheDocument()
  })

  it('消息标签页里长正文默认折叠，可展开，并显示真实字符数', async () => {
    mockFetch({ ok: true, result: view() })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /消息 2/ }))

    const expand = screen.getByRole('button', { name: /展开全文（1.2 KB）/ })
    expect(screen.getByText('截断')).toBeInTheDocument()
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()
  })

  it('搜索只在消息里过滤，命中之外的消息不出现', async () => {
    mockFetch({ ok: true, result: view() })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /消息 2/ }))

    const search = screen.getByPlaceholderText('在消息正文里搜索…')
    fireEvent.change(search, { target: { value: 'hello' } })
    expect(screen.getByText(/#0/)).toBeInTheDocument()
    expect(screen.queryByText(/#1/)).not.toBeInTheDocument()
  })

  it('旧 bridge 不认这条命令时给出可执行的提示，而不是「加载失败」', async () => {
    mockFetch({ error: 'unsupported_command', message: 'this command is not supported' }, 400)
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/没有加载最新版 live-session 扩展/)).toBeInTheDocument())
    expect(screen.getByText(/重载/)).toBeInTheDocument()
  })

  it('会话能力缺失时不发请求，直接说明去重载', async () => {
    const calls = mockFetch({ ok: true, result: view() })
    render(<ContextInspector processInstanceId="process-a" capable={false} onClose={() => {}} />)

    expect(await screen.findByText(/还在跑旧版 live-session 扩展/)).toBeInTheDocument()
    expect(screen.getByText(/重载/)).toBeInTheDocument()
    // 没能力就不该去打接口：失败路径不该靠一次报错来发现。
    expect(calls).toHaveLength(0)
    expect(screen.queryByText('真实请求')).not.toBeInTheDocument()
  })

  it('旧版扩展没带版本号时说清楚「缺字段不等于空」', async () => {
    mockFetch({ ok: true, result: view({ version: undefined, systemParts: [] }) })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)

    expect(await screen.findByText(/这份数据来自旧版扩展/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /系统提示/ }))
    expect(screen.getByText(/这个会话的扩展是旧版本，拆不出内容块/)).toBeInTheDocument()
  })

  it('新版扩展但没有可拆分标记块时，不冒充旧版本', async () => {
    mockFetch({ ok: true, result: view({ systemParts: [] }) })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /系统提示/ }))
    expect(screen.getByText(/全部算在「基础提示」之外无处可拆/)).toBeInTheDocument()
    expect(screen.queryByText(/旧版本，拆不出内容块/)).not.toBeInTheDocument()
  })

  it('刷新会重新请求同一个会话', async () => {
    const calls = mockFetch({ ok: true, result: view() })
    render(<ContextInspector processInstanceId="process-a" onClose={() => {}} />)
    await screen.findByText('上下文检查')
    await waitFor(() => expect(calls).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[0]).toContain('/api/live-sessions/process-a/commands')
  })
})