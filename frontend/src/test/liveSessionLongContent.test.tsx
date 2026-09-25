import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CollapsibleMarkdown, stablePartKeys } from '../features/live-sessions/LiveSessionPage'

const LONG = Array.from({ length: 30 }, (_, index) => `行 ${index + 1}`).join('\n\n')

describe('长消息的两种读法', () => {
  it('两个按钮：就地展开（可收回）与弹窗阅读', () => {
    const onReadStart = vi.fn()
    render(<CollapsibleMarkdown content={LONG} onFileOpen={() => {}} onReadStart={onReadStart} />)

    expect(screen.getByRole('button', { name: '弹窗阅读' })).toBeInTheDocument()
    const unfold = screen.getByRole('button', { name: /展开全部/ })
    expect(screen.queryByText('行 30')).not.toBeInTheDocument()

    fireEvent.click(unfold)

    // In place, not in a window, and the reader is no longer following the tail.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('行 30')).toBeInTheDocument()
    expect(onReadStart).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByText('行 30')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /展开全部/ })).toBeInTheDocument()
  })

  it('弹窗阅读仍然可用，并暂停跟随最新消息', async () => {
    const onReadStart = vi.fn()
    render(<CollapsibleMarkdown content={LONG} onFileOpen={() => {}} onReadStart={onReadStart} />)

    fireEvent.click(screen.getByRole('button', { name: '弹窗阅读' }))

    expect(await screen.findByRole('dialog', { name: '完整内容' })).toBeInTheDocument()
    expect(screen.getByText('行 30')).toBeInTheDocument()
    expect(onReadStart).toHaveBeenCalledTimes(1)
  })

  it('展开后滚动锚定写在同一个滚动容器上（真实浏览器才可测）', () => {
    // jsdom reports zero-size rects, so the offset maths cannot be asserted here.
    // What must hold is that the anchor target exists: without it the correction
    // silently no-ops and the reader is pushed away again.
    const { container } = render(
      <div data-timeline-scroll="">
        <CollapsibleMarkdown content={LONG} onFileOpen={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /展开全部/ }))
    const actions = screen.getByRole('button', { name: '收起' }).parentElement
    expect(actions?.closest('[data-timeline-scroll]')).toBe(container.firstElementChild)
  })
})

describe('stablePartKeys', () => {
  it('精简阅读过滤掉 thinking/tool 后，文本部分的 key 不变', () => {
    const full = [
      { type: 'thinking', thinking: '先想一下' },
      { type: 'text', text: '回答正文' },
      { type: 'toolCall', name: 'bash' },
      { type: 'text', text: '回答正文' },
    ]
    const compact = full.filter(part => part.type !== 'thinking' && part.type !== 'toolCall')

    expect(stablePartKeys(compact)).toEqual([stablePartKeys(full)[1], stablePartKeys(full)[3]])
  })

  it('同一内容重复出现时仍然唯一', () => {
    const keys = stablePartKeys([{ type: 'text', text: 'same' }, { type: 'text', text: 'same' }])
    expect(new Set(keys).size).toBe(2)
  })
})