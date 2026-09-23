import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ReviewCommentsDialog from '../components/ReviewCommentsDialog'
import type { ReviewItem } from '../utils/reviewComments'

const items: ReviewItem[] = [
  { id: 'c1', label: 'Line 5', content: 'Fix typo', quote: 'teh file' },
  { id: 'c2', label: 'Lines 10-15', content: 'Refactor this' },
]

const baseProps = {
  target: '/tmp/spec.md',
  items,
  onCancel: vi.fn(),
  onSend: vi.fn(),
}

beforeEach(() => { vi.clearAllMocks() })

describe('ReviewCommentsDialog', () => {
  it('lists every comment with line reference and quote', () => {
    const { container } = render(<ReviewCommentsDialog {...baseProps} />)
    const first = container.querySelector('[data-review-comment-id="c1"]')!
    expect(first.textContent).toContain('Line 5')
    expect(first.textContent).toContain('Fix typo')
    expect(first.textContent).toContain('“teh file”')
    const second = container.querySelector('[data-review-comment-id="c2"]')!
    expect(second.textContent).toContain('Lines 10-15')
    expect(second.textContent).toContain('Refactor this')
  })

  it('prefills the message with the generated review text', () => {
    render(<ReviewCommentsDialog {...baseProps} />)
    const message = (screen.getByLabelText('Review message') as HTMLTextAreaElement).value
    expect(message).toContain('Please review and address the comments in /tmp/spec.md')
    expect(message).toContain('[1] Line 5\nQuoted: "teh file"\nComment: Fix typo')
  })

  it('drops a comment from the message when removed', () => {
    render(<ReviewCommentsDialog {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /remove comment on line 5/i }))
    const message = (screen.getByLabelText('Review message') as HTMLTextAreaElement).value
    expect(message).not.toContain('Fix typo')
    expect(message).toContain('Refactor this')
  })

  it('keeps manual edits when a comment is removed', () => {
    render(<ReviewCommentsDialog {...baseProps} />)
    const area = screen.getByLabelText('Review message') as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: 'hand written note' } })
    fireEvent.click(screen.getByRole('button', { name: /remove comment on line 5/i }))
    expect((screen.getByLabelText('Review message') as HTMLTextAreaElement).value).toBe('hand written note')
  })

  it('sends the edited message together with the remaining comment ids', () => {
    render(<ReviewCommentsDialog {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /remove comment on line 5/i }))
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }))
    expect(baseProps.onSend).toHaveBeenCalledWith(expect.stringContaining('Refactor this'), ['c2'])
  })

  it('disables Send when every comment was removed', () => {
    render(<ReviewCommentsDialog {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /remove comment on line 5/i }))
    fireEvent.click(screen.getByRole('button', { name: /remove comment on lines 10-15/i }))
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled()
  })

  it('cancels without sending', () => {
    render(<ReviewCommentsDialog {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  it('closes on Escape without leaking Escape to the underlying panel', () => {
    const underlying = vi.fn()
    document.addEventListener('keydown', underlying)
    render(<ReviewCommentsDialog {...baseProps} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1)
    expect(underlying).not.toHaveBeenCalled()
    document.removeEventListener('keydown', underlying)
  })
})