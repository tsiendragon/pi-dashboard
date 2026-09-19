import { describe, expect, it } from 'vitest'
import { chunkText, extractAssistantText, textContent } from './render.js'

describe('textContent', () => {
  it('joins text parts and skips thinking/toolCall', () => {
    const content = [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'hello' },
      { type: 'toolCall', name: 'bash' },
      { type: 'text', text: 'world' },
    ]
    expect(textContent(content)).toBe('hello\nworld')
  })

  it('passes through plain strings', () => {
    expect(textContent('x')).toBe('x')
  })

  it('returns empty for unknown shapes', () => {
    expect(textContent(undefined)).toBe('')
    expect(textContent(42)).toBe('')
  })
})

describe('extractAssistantText', () => {
  it('returns the body for a completed assistant message', () => {
    const data = { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }
    expect(extractAssistantText('message_end', data)).toBe('hi')
  })

  it('ignores non-terminal events', () => {
    expect(extractAssistantText('message_update', { message: { role: 'assistant', content: 'x' } })).toBeUndefined()
    expect(extractAssistantText('tool_execution_end', {})).toBeUndefined()
  })

  it('ignores user messages and empty assistant messages', () => {
    expect(extractAssistantText('message_end', { message: { role: 'user', content: 'x' } })).toBeUndefined()
    expect(
      extractAssistantText('message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } }),
    ).toBeUndefined()
  })
})

describe('chunkText', () => {
  it('keeps short text intact', () => {
    expect(chunkText('abc', 10)).toEqual(['abc'])
  })

  it('splits on a newline boundary', () => {
    expect(chunkText('aaaa\nbbbb\ncccc', 10)).toEqual(['aaaa\nbbbb', 'cccc'])
  })

  it('hard-splits without losing characters', () => {
    const text = 'x'.repeat(25)
    expect(chunkText(text, 10).join('')).toBe(text)
  })
})
