import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import FullContentModal from '../components/FullContentModal'

describe('FullContentModal', () => {
  it('shows the whole content in its own window', () => {
    render(<FullContentModal content={'# 标题\n\n正文一段'} meta="3 行" onClose={() => {}} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('完整内容')).toBeInTheDocument()
    expect(screen.getByText('3 行')).toBeInTheDocument()
    expect(screen.getByText('正文一段')).toBeInTheDocument()
  })

  it('moves focus into the window and back to the trigger', () => {
    function Harness(): React.ReactElement {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>展开全部（32 行）</button>
          {open && <FullContentModal content="正文" onClose={() => setOpen(false)} />}
        </div>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '展开全部（32 行）' })
    // jsdom does not focus a button on click the way a browser does.
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(trigger).toHaveFocus()
  })

  it('closes on Escape and on the 关闭 button', () => {
    const onClose = vi.fn()
    render(<FullContentModal content="x" onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on the backdrop but stays open on clicks inside', () => {
    const onClose = vi.fn()
    render(<FullContentModal content="正文" onClose={onClose} />)
    fireEvent.click(screen.getByText('正文'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Escape away from the page behind it', () => {
    const onClose = vi.fn()
    // The global shortcut listener sits on the bubble phase on `document`; Escape
    // inside the window must not reach it (that would also fire 「关闭 / 停止」).
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    render(<FullContentModal content="x" onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    document.removeEventListener('keydown', behind)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(behind).not.toHaveBeenCalled()
  })

  it('carries the message role so quotes taken here name their source', () => {
    const { unmount } = render(<FullContentModal content="正文" anchorRole="user" onClose={() => {}} />)
    const anchor = screen.getByRole('dialog').querySelector('[data-msg-anchor]') as HTMLElement
    expect(anchor.getAttribute('data-msg-role')).toBe('user')
    unmount()
    render(<FullContentModal content="正文" onClose={() => {}} />)
    const plain = screen.getByRole('dialog').querySelector('[data-msg-anchor]') as HTMLElement
    expect(plain.hasAttribute('data-msg-role')).toBe(false)
  })

  it('honours the transcript raw toggle', () => {
    // MarkdownRenderer only offers the raw view for content longer than 20 chars.
    const long = '这是一段够长的内容，用来让 raw 开关出现，否则它不会渲染。'
    const { unmount } = render(<FullContentModal content={long} onClose={() => {}} />)
    expect(screen.getByText('raw')).toBeInTheDocument()
    unmount()
    render(<FullContentModal content={long} showRaw={false} onClose={() => {}} />)
    expect(screen.queryByText('raw')).not.toBeInTheDocument()
  })
})