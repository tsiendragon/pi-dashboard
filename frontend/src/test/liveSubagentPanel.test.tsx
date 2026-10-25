import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LiveSessionDetail, LiveSessionSummary } from '@shared/live-sessions'
import LiveSubagentPanel from '../features/live-sessions/LiveSubagentPanel'

const summary: LiveSessionSummary = {
  processInstanceId: 'proc-1',
  sessionId: 'session-1',
  role: 'subagent',
  pid: 4242,
  cwd: '/tmp/work',
  canonicalCwd: '/tmp/work',
  mode: 'rpc',
  status: 'idle',
  claim: { state: 'claimed' },
  startedAt: 0,
  lastActivityAt: 0,
  revision: 1,
  eventSequence: 1,
}

function renderPanel(entries: unknown[]) {
  const detail: LiveSessionDetail = { summary, entries }
  return render(
    <LiveSubagentPanel summary={summary} detail={detail} onClose={() => {}} onOpenFull={() => {}} />,
  )
}

function panelElement(entries: unknown[]) {
  const detail: LiveSessionDetail = { summary, entries }
  return <LiveSubagentPanel summary={summary} detail={detail} onClose={() => {}} onOpenFull={() => {}} />
}

describe('子 Agent 侧栏在流式更新中保留已展开的内容', () => {
  it('keeps the same row mounted when entries before it drop out', () => {
    const reply = {
      type: 'message',
      id: 'msg-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先核对一下服务状态' },
          { type: 'text', text: '服务已经起来了。' },
        ],
      },
    }
    const { container, rerender } = renderPanel([reply])
    const row = container.querySelector('article')
    expect(row).not.toBeNull()

    // Trimming the oldest entries shifts every position; the row must keep its identity
    // so the「思考过程」the reader unfolded is not silently closed.
    rerender(panelElement([
      { type: 'message', id: 'msg-0', message: { role: 'user', content: '看一下服务' } },
      reply,
    ]))

    expect(container.querySelectorAll('article')[1]).toBe(row)
  })
})

describe('子 Agent 侧栏的工具输出', () => {
  it('folds a tool result message and shows readable text once unfolded', () => {
    const entries = [{
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'webfetch',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: JSON.stringify([{ url: 'https://example.com', result: '第一行\n第二行' }]) }],
      },
    }]
    const { container } = renderPanel(entries)

    // Folded: the reader sees the one-line summary, not the page of output.
    expect(container.querySelector('[aria-label="成功"]')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /展开/ }))

    // Unfolded: the envelope is unwrapped into the text it carried.
    expect(container.querySelector('pre')?.textContent).toBe('第一行\n第二行')
  })

  it('restores escaped line breaks of a raw execution result', () => {
    const entries = [{
      type: 'tool_execution_end',
      data: {
        type: 'tool_execution_end',
        toolCallId: 'call-2',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'line one\\nline two' }] },
      },
    }]
    const { container } = renderPanel(entries)

    fireEvent.click(screen.getByRole('button', { name: /展开/ }))

    expect(container.querySelector('pre')?.textContent).toBe('line one\nline two')
  })

  it('marks a failed tool result as an error', () => {
    const entries = [{
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'bash',
        toolCallId: 'call-3',
        isError: true,
        content: [{ type: 'text', text: '命令执行失败：exit 1' }],
      },
    }]
    const { container } = renderPanel(entries)

    expect(container.querySelector('[aria-label="失败"]')).not.toBeNull()
  })

  it('shows one card when the same result arrives as both an event and a message', () => {
    const entries = [
      {
        type: 'tool_execution_end',
        data: {
          type: 'tool_execution_end',
          toolCallId: 'call-9',
          toolName: 'bash',
          isError: false,
          result: { content: [{ type: 'text', text: '重试后成功' }] },
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'call-9',
          content: [{ type: 'text', text: '重试后成功' }],
        },
      },
    ]
    const { container } = renderPanel(entries)

    expect(container.querySelectorAll('article')).toHaveLength(1)
  })
})