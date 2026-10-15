import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuoteCommentPopover } from '../components/SelectionQuoteMenu'
import ReviewCommentsDialog from '../components/ReviewCommentsDialog'
import type { SelectionTarget } from '../hooks/useChatQuoteSelection'
import type { ReviewItem } from '../utils/reviewComments'

const voiceMock = vi.hoisted(() => ({
  toggle: vi.fn(),
  language: undefined as string | undefined,
  onTranscript: undefined as ((text: string) => void) | undefined,
}))

vi.mock('../features/voice/useVoiceInput', () => ({
  appendVoiceTranscript: (current: string, transcript: string) => (
    !current || !/\S/.test(current) ? `${current}${transcript}` : `${current}${/\s$/.test(current) ? '' : ' '}${transcript}`
  ),
  useVoiceInput: (options: { language?: string; onTranscript?: (text: string) => void } = {}) => {
    voiceMock.language = options.language
    voiceMock.onTranscript = options.onTranscript
    return {
      listening: false,
      connecting: false,
      transcribing: false,
      interimTranscript: '',
      supported: true,
      error: undefined,
      toggle: voiceMock.toggle,
      stop: vi.fn(),
      clearError: vi.fn(),
    }
  },
}))

const target: SelectionTarget = {
  id: 'quote-1',
  text: 'quoted words',
  role: 'assistant',
  rect: { top: 200, bottom: 220, left: 300, width: 100 },
}

const items: ReviewItem[] = [
  { id: 'c1', label: 'Line 5', content: 'Fix typo', quote: 'teh file' },
  { id: 'c2', label: 'Lines 10-15', content: 'Refactor this' },
]

beforeEach(() => {
  voiceMock.toggle.mockReset()
  voiceMock.language = undefined
  voiceMock.onTranscript = undefined
})

describe('voice input for comments', () => {
  it('adds dictated text to a quoted comment without replacing typed text', () => {
    render(<QuoteCommentPopover target={target} language="zh" onSave={vi.fn()} onCancel={vi.fn()} />)
    const input = screen.getByLabelText('批注内容') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '已有意见' } })

    expect(voiceMock.language).toBe('zh')
    fireEvent.click(screen.getByRole('button', { name: '开始语音输入' }))
    expect(voiceMock.toggle).toHaveBeenCalledOnce()
    act(() => voiceMock.onTranscript?.('补充意见'))

    expect(input.value).toBe('已有意见 补充意见')
  })

  it('appends dictated text to the final review message and keeps it when comments change', () => {
    render(<ReviewCommentsDialog target="/tmp/spec.md" items={items} language="en" onCancel={vi.fn()} onSend={vi.fn()} />)
    const message = screen.getByLabelText('Review message') as HTMLTextAreaElement
    const initialMessage = message.value

    expect(voiceMock.language).toBe('en')
    fireEvent.click(screen.getByRole('button', { name: '开始语音输入' }))
    act(() => voiceMock.onTranscript?.('Please also update the title.'))
    expect(message.value).toBe(initialMessage + ' Please also update the title.')

    fireEvent.click(screen.getByRole('button', { name: /remove comment on line 5/i }))
    expect(message.value).toContain('Please also update the title.')
  })
})
