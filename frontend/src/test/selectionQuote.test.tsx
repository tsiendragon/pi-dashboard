import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { SelectionQuoteMenu, QuoteCommentPopover } from '../components/SelectionQuoteMenu'
import { useChatQuoteSelection, targetFromSelection, type SelectionTarget } from '../hooks/useChatQuoteSelection'
import LiveSessionComposer from '../features/live-sessions/LiveSessionComposer'

const rect = { top: 200, bottom: 220, left: 100, width: 80 }

function fakeSelection(over: { text?: string; collapsed?: boolean; node?: Node | null } = {}) {
  const node = over.node ?? null
  return {
    isCollapsed: over.collapsed ?? false,
    rangeCount: 1,
    toString: () => over.text ?? '',
    anchorNode: node,
    focusNode: node,
    getRangeAt: () => ({ startContainer: node, commonAncestorContainer: node, getBoundingClientRect: () => rect }),
  }
}

function mockSelection(selection: unknown) {
  vi.spyOn(window, 'getSelection').mockReturnValue(selection as any)
}

beforeEach(() => { vi.restoreAllMocks() })

describe('targetFromSelection', () => {
  it('builds a quote target from a selection inside a message', () => {
    const anchor = document.createElement('article')
    anchor.setAttribute('data-msg-anchor', '')
    anchor.setAttribute('data-msg-role', 'assistant')
    anchor.setAttribute('data-msg-id', 'entry-7')
    anchor.textContent = '方案 1 实现已完成。'
    document.body.appendChild(anchor)
    mockSelection(fakeSelection({ text: '  方案 1 实现已完成。\n', node: anchor }))

    const target = targetFromSelection()
    expect(target).toMatchObject({ text: '方案 1 实现已完成。', role: 'assistant', entryId: 'entry-7', rect })
    anchor.remove()
  })

  it('ignores selections outside any message', () => {
    const outside = document.createElement('div')
    outside.textContent = '侧栏文字'
    document.body.appendChild(outside)
    mockSelection(fakeSelection({ text: '侧栏文字', node: outside }))
    expect(targetFromSelection()).toBeNull()
    outside.remove()
  })

  it('ignores selections made inside its own floating UI', () => {
    const ui = document.createElement('div')
    ui.setAttribute('data-quote-ui', '')
    const inner = document.createElement('span')
    inner.textContent = '引用预览'
    ui.appendChild(inner)
    document.body.appendChild(ui)
    mockSelection(fakeSelection({ text: '引用预览', node: inner }))
    expect(targetFromSelection()).toBeNull()
    ui.remove()
  })

  it('ignores collapsed and empty selections', () => {
    mockSelection(fakeSelection({ collapsed: true }))
    expect(targetFromSelection()).toBeNull()
    mockSelection(fakeSelection({ text: '   ' }))
    expect(targetFromSelection()).toBeNull()
  })
})

function SelectionHarness() {
  const { selection, clear } = useChatQuoteSelection()
  return (
    <div>
      <article data-msg-anchor="" data-msg-role="user">这是我的消息</article>
      {selection ? <div data-testid="menu">{`${selection.role}:${selection.text}`}</div> : null}
      <button type="button" onClick={clear}>reset</button>
    </div>
  )
}

describe('useChatQuoteSelection', () => {
  it('opens on mouseup and closes when the selection collapses or Escape is pressed', () => {
    const { container } = render(<SelectionHarness />)
    const anchor = container.querySelector('[data-msg-anchor]')!
    mockSelection(fakeSelection({ text: '这是我的消息', node: anchor }))

    fireEvent.mouseUp(document)
    expect(screen.getByTestId('menu').textContent).toBe('user:这是我的消息')

    mockSelection(fakeSelection({ collapsed: true }))
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(screen.queryByTestId('menu')).toBeNull()

    mockSelection(fakeSelection({ text: '这是我的消息', node: anchor }))
    fireEvent.mouseUp(document)
    expect(screen.getByTestId('menu')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('menu')).toBeNull()
  })
})

describe('SelectionQuoteMenu', () => {
  const target: SelectionTarget = { id: 'q1', text: '一段话', role: 'assistant', rect }

  it('offers both quoting actions', () => {
    const onQuote = vi.fn()
    const onComment = vi.fn()
    render(<SelectionQuoteMenu target={target} onQuote={onQuote} onComment={onComment} />)
    fireEvent.click(screen.getByRole('menuitem', { name: /引用回复/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /批注/ }))
    expect(onQuote).toHaveBeenCalledWith(target)
    expect(onComment).toHaveBeenCalledWith(target)
  })
})

describe('QuoteCommentPopover', () => {
  const target: SelectionTarget = { id: 'q1', text: '一段话', role: 'assistant', rect }

  it('keeps the save action disabled until there is a comment', () => {
    render(<QuoteCommentPopover target={target} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/一段话/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加批注' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('批注内容'), { target: { value: '改成常显' } })
    expect(screen.getByRole('button', { name: '添加批注' })).not.toBeDisabled()
  })

  it('saves with Enter and cancels with Escape', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<QuoteCommentPopover target={target} onSave={onSave} onCancel={onCancel} />)
    const input = screen.getByLabelText('批注内容')
    fireEvent.change(input, { target: { value: '改成常显' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith('改成常显')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('LiveSessionComposer quoted replies', () => {
  it('sends the selected text as a quote block together with the message', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onClearQuotes = vi.fn()
    render(
      <LiveSessionComposer
        status="idle"
        onSubmit={onSubmit}
        quotes={[{ id: 'q1', text: '方案 1 实现已完成。', role: 'assistant' }]}
        onClearQuotes={onClearQuotes}
      />,
    )
    expect(screen.getByLabelText('待发送引用').textContent).toContain('方案 1 实现已完成。')

    fireEvent.change(screen.getByPlaceholderText('针对引用的说明…'), { target: { value: '你说的这一步我不同意' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(onSubmit).toHaveBeenCalledWith(
      '引用（来自你的回复）：\n> 方案 1 实现已完成。\n\n你说的这一步我不同意',
      undefined,
    )
    await waitFor(() => expect(onClearQuotes).toHaveBeenCalled())
  })

  it('allows sending a quote with no typed text', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <LiveSessionComposer
        status="idle"
        onSubmit={onSubmit}
        quotes={[{ id: 'q1', text: '只引用不评论', role: 'user' }]}
      />,
    )
    const send = screen.getByRole('button', { name: '发送' })
    expect(send).not.toBeDisabled()
    fireEvent.click(send)
    expect(onSubmit).toHaveBeenCalledWith('引用（来自我的消息）：\n> 只引用不评论', undefined)
  })

  it('lets a quote chip be removed', () => {
    const onRemoveQuote = vi.fn()
    render(
      <LiveSessionComposer
        status="idle"
        onSubmit={vi.fn()}
        quotes={[{ id: 'q1', text: '要删掉的引用', role: 'assistant' }]}
        onRemoveQuote={onRemoveQuote}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /移除引用/ }))
    expect(onRemoveQuote).toHaveBeenCalledWith('q1')
  })
})