import { describe, it, expect } from 'vitest'
import {
  MAX_QUOTE_CHARS,
  buildQuoteReplyMessage,
  buildReviewMessage,
  commentReviewItems,
  describeCommentTarget,
  formatLineRef,
  normalizeQuote,
  resolveSelectionToLines,
  selectionLabel,
} from '../utils/reviewComments'
import type { Comment } from '../hooks/usePanelState'

const comment = (over: Partial<Comment>): Comment => ({
  id: 'c1',
  startLine: 1,
  endLine: 1,
  content: 'fix',
  version: 1,
  createdAt: '2026-04-14T10:00:00Z',
  ...over,
})

describe('commentReviewItems', () => {
  it('maps stored comments onto dialog items', () => {
    const items = commentReviewItems([comment({ id: 'c1', startLine: 4, endLine: 6, content: '改口径', quote: '原文' })])
    expect(items).toEqual([{ id: 'c1', label: 'Lines 4-6', quote: '原文', content: '改口径' }])
  })
})

describe('normalizeQuote', () => {
  it('collapses whitespace and newlines into one trimmed line', () => {
    expect(normalizeQuote('  hello\n   world \t')).toBe('hello world')
  })

  it('returns undefined for empty or blank selections', () => {
    expect(normalizeQuote('')).toBeUndefined()
    expect(normalizeQuote('   \n  ')).toBeUndefined()
    expect(normalizeQuote(null)).toBeUndefined()
    expect(normalizeQuote(undefined)).toBeUndefined()
  })

  it('truncates overly long quotes with an ellipsis', () => {
    const long = 'x'.repeat(MAX_QUOTE_CHARS + 50)
    const quote = normalizeQuote(long)!
    expect(quote).toHaveLength(MAX_QUOTE_CHARS)
    expect(quote.endsWith('…')).toBe(true)
  })

  it('keeps quotes at the limit untouched', () => {
    const exact = 'y'.repeat(MAX_QUOTE_CHARS)
    expect(normalizeQuote(exact)).toBe(exact)
  })
})

describe('formatLineRef', () => {
  it('formats single lines and ranges', () => {
    expect(formatLineRef({ startLine: 5, endLine: 5 })).toBe('Line 5')
    expect(formatLineRef({ startLine: 10, endLine: 15 })).toBe('Lines 10-15')
  })
})

describe('describeCommentTarget', () => {
  it('appends the quoted sentence when present', () => {
    expect(describeCommentTarget(3, 3)).toBe('line 3')
    expect(describeCommentTarget(3, 3, 'the claim')).toBe('line 3 — “the claim”')
    expect(describeCommentTarget(3, 5, 'the claim')).toBe('lines 3–5 — “the claim”')
  })
})

describe('buildReviewMessage', () => {
  it('numbers every comment with its line reference and quote', () => {
    const message = buildReviewMessage('/tmp/spec.md', commentReviewItems([
      comment({ id: 'c1', startLine: 12, endLine: 14, content: '口径不对', quote: '净额按日汇总' }),
      comment({ id: 'c2', startLine: 30, endLine: 30, content: '删掉这句' }),
    ]))
    expect(message).toBe(
      'Please review and address the comments in /tmp/spec.md:\n\n' +
      '[1] Lines 12-14\nQuoted: "净额按日汇总"\nComment: 口径不对\n\n' +
      '[2] Line 30\nComment: 删掉这句',
    )
  })

  it('uses the singular label for one comment', () => {
    const message = buildReviewMessage('/tmp/a.md', commentReviewItems([comment({ content: 'typo' })]))
    expect(message).toContain('address the comment in /tmp/a.md')
  })

  it('omits the quote line when a comment has none', () => {
    const message = buildReviewMessage('/tmp/a.md', commentReviewItems([comment({ content: 'typo' })]))
    expect(message).not.toContain('Quoted:')
    expect(message).toContain('[1] Line 1\nComment: typo')
  })

  it('accepts conversation items with a custom intro', () => {
    const message = buildReviewMessage('上面的会话', [
      { id: 'q1', label: '你的回复', quote: '触屏上没有 hover', content: '改成常显' },
    ], 'Please review these comments about the conversation:')
    expect(message).toBe(
      'Please review these comments about the conversation:\n\n' +
      '[1] 你的回复\nQuoted: "触屏上没有 hover"\nComment: 改成常显',
    )
  })
})

describe('selectionLabel', () => {
  it('names the speaker of a quoted message', () => {
    expect(selectionLabel('assistant')).toBe('你的回复')
    expect(selectionLabel('user')).toBe('我的消息')
    expect(selectionLabel(undefined)).toBe('会话内容')
  })
})

describe('buildQuoteReplyMessage', () => {
  it('renders one markdown quote block per selection', () => {
    const message = buildQuoteReplyMessage([
      { id: 'q1', text: '方案 1 已完成', role: 'assistant' },
      { id: 'q2', text: '这条我自己写的', role: 'user' },
    ])
    expect(message).toBe([
      '引用（来自你的回复）：',
      '> 方案 1 已完成',
      '',
      '引用（来自我的消息）：',
      '> 这条我自己写的',
    ].join('\n'))
  })

  it('quotes every line of a multi-line selection', () => {
    const message = buildQuoteReplyMessage([{ id: 'q1', text: '第一行\n第二行' }])
    expect(message).toBe('引用（来自会话内容）：\n> 第一行\n> 第二行')
  })

  it('returns an empty string when nothing is quoted', () => {
    expect(buildQuoteReplyMessage([])).toBe('')
  })
})

describe('resolveSelectionToLines', () => {
  it('maps an exact rendered selection back to its source line', () => {
    const content = '# Title\n\nSome body text\nMore text'
    expect(resolveSelectionToLines(content, 'Some body text')).toEqual({ startLine: 3, endLine: 3 })
  })

  it('falls back to markdown-stripped matching', () => {
    const content = '**bold** claim here'
    expect(resolveSelectionToLines(content, 'bold claim here')).toEqual({ startLine: 1, endLine: 1 })
  })

  it('spans multiple selected lines', () => {
    const content = 'alpha\nbeta\ngamma'
    expect(resolveSelectionToLines(content, 'alpha\nbeta')).toEqual({ startLine: 1, endLine: 2 })
  })

  it('falls back to line 1 for an empty selection', () => {
    expect(resolveSelectionToLines('alpha\nbeta', '')).toEqual({ startLine: 1, endLine: 1 })
  })
})