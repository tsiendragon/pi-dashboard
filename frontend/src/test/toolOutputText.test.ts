import { describe, expect, it } from 'vitest'
import { normalizeToolOutputText } from '../utils/toolOutputText'

describe('normalizeToolOutputText', () => {
  it('unwraps a serialized envelope to the text it carries', () => {
    const raw = JSON.stringify([
      { url: 'https://example.com/doc', result: '# 标题\n\n正文第一行\n正文第二行' },
    ])

    expect(normalizeToolOutputText(raw)).toBe('# 标题\n\n正文第一行\n正文第二行')
  })

  it('reads text parts of a content envelope', () => {
    const raw = JSON.stringify({ content: [{ type: 'text', text: '工具读到的第一段文字' }] })

    expect(normalizeToolOutputText(raw)).toBe('工具读到的第一段文字')
  })

  it('restores line breaks that were escaped into two characters', () => {
    expect(normalizeToolOutputText('第一行\\n第二行\\n\\t缩进')).toBe('第一行\n第二行\n\t缩进')
  })

  it('leaves text that already has real line breaks alone', () => {
    const text = '第一行\n第二行'
    expect(normalizeToolOutputText(text)).toBe(text)
  })

  it('keeps structured data verbatim when there is no readable text inside', () => {
    expect(normalizeToolOutputText('[1, 2, 3]')).toBe('[1, 2, 3]')
    expect(normalizeToolOutputText('{"status":"ok"}')).toBe('{"status":"ok"}')
  })

  it('returns nothing for no output', () => {
    expect(normalizeToolOutputText('')).toBe('')
  })
})