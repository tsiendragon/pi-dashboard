import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import LiveQueueBar, { LiveApprovalCard } from '../features/live-sessions/LiveApprovalQueue'
import type { LiveSessionQueue, LiveSessionUiRequest } from '@shared/live-sessions'

const queue = (overrides: Partial<LiveSessionQueue> = {}): LiveSessionQueue => ({
  items: [
    { id: 'q1', text: '顺便跑一下 lint', channel: 'web', deliverAs: 'steer', imageCount: 0 },
    { id: 'q2', text: '然后更新 README', channel: 'mobile', imageCount: 1 },
  ],
  active: null,
  ...overrides,
})

describe('Web queue bar', () => {
  it('summarises what the bridge still holds and expands on demand', async () => {
    const onQueue = vi.fn().mockResolvedValue(queue())
    render(<LiveQueueBar processInstanceId="p" enabled revision={0} onQueue={onQueue} onWithdraw={vi.fn()} />)
    expect(await screen.findByText('2 条消息还在排队')).toBeInTheDocument()
    // Collapsed: only the first prompt is visible, the list stays closed.
    expect(screen.getByText('顺便跑一下 lint')).toBeInTheDocument()
    expect(screen.queryByText('然后更新 README')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.getByText('然后更新 README')).toBeInTheDocument()
    expect(screen.getByText('排队 · 1 张图片 · mobile')).toBeInTheDocument()
  })

  it('withdraws exactly the row that was clicked and re-reads the bridge', async () => {
    const onQueue = vi.fn()
      .mockResolvedValueOnce(queue())
      .mockResolvedValueOnce(queue({ items: [queue().items[1]] }))
    const onWithdraw = vi.fn().mockResolvedValue({ cancelled: true, remaining: 1 })
    render(<LiveQueueBar processInstanceId="p" enabled revision={0} onQueue={onQueue} onWithdraw={onWithdraw} />)
    await screen.findByText('2 条消息还在排队')
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    fireEvent.click(screen.getAllByRole('button', { name: '撤回' })[0])
    await waitFor(() => expect(onWithdraw).toHaveBeenCalledWith('p', 'q1'))
    // The bar re-reads instead of splicing optimistically, so a lost race is visible.
    await waitFor(() => expect(screen.getByText('1 条消息还在排队')).toBeInTheDocument())
  })

  it('keeps the row and explains why when a withdrawal fails', async () => {
    const onWithdraw = vi.fn().mockRejectedValue(new Error('queue_item_active: 这条已经开始执行'))
    render(<LiveQueueBar processInstanceId="p" enabled revision={0} onQueue={vi.fn().mockResolvedValue(queue())} onWithdraw={onWithdraw} />)
    await screen.findByText('2 条消息还在排队')
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    fireEvent.click(screen.getAllByRole('button', { name: '撤回' })[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('queue_item_active')
    expect(screen.getAllByRole('button', { name: '撤回' })).toHaveLength(2)
  })

  it('shows a dispatched prompt without offering a withdrawal', async () => {
    render(
      <LiveQueueBar
        processInstanceId="p" enabled revision={0}
        onQueue={vi.fn().mockResolvedValue(queue({ items: [], active: { id: 'a', text: '正在跑测试' } }))}
        onWithdraw={vi.fn()}
      />,
    )
    expect(await screen.findByText('没有可撤回的排队消息')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.getByText(/正在发送（已交给 Pi，无法撤回）/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤回' })).not.toBeInTheDocument()
  })

  it('stays hidden without the capability or when nothing is queued', async () => {
    const onQueue = vi.fn().mockResolvedValue(queue({ items: [], active: null }))
    const { container, rerender } = render(
      <LiveQueueBar processInstanceId="p" enabled revision={0} onQueue={onQueue} onWithdraw={vi.fn()} />,
    )
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    rerender(<LiveQueueBar processInstanceId="p" enabled={false} revision={0} onQueue={onQueue} onWithdraw={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Web approval card', () => {
  const request = (overrides: Partial<LiveSessionUiRequest> = {}): LiveSessionUiRequest => ({
    id: 'ui-1', method: 'confirm', title: '允许运行 rm -rf build', message: '影响 /srv/projects/demo', ...overrides,
  })

  it('answers allow and deny with the plain boolean the bridge expects', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<LiveApprovalCard requests={[request()]} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ui-1' }), true)

    rerender(<LiveApprovalCard requests={[request({ id: 'ui-2' })]} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ui-2' }), false)
  })

  it('counts the remaining requests instead of hiding them', () => {
    render(<LiveApprovalCard requests={[request(), request({ id: 'ui-2' }), request({ id: 'ui-3' })]} onAnswer={vi.fn()} />)
    expect(screen.getByText('还有 2 个')).toBeInTheDocument()
  })

  it('keeps the request visible when the answer fails', async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error('请求已失效或已在其他端处理'))
    render(<LiveApprovalCard requests={[request()]} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请求已失效')
    expect(screen.getByText('允许运行 rm -rf build')).toBeInTheDocument()
  })

  it('does not render a dialog-style prompt in the card', () => {
    const { container } = render(<LiveApprovalCard requests={[]} onAnswer={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})