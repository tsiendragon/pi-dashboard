import { describe, expect, it, vi } from 'vitest'
import { projectMachinePreview } from '../machine-preview.js'
import type { LiveSessionDetail } from '../../shared/src/live-sessions.js'

const detail = (entries: unknown[], sessionId = 'current') => ({
  summary: { sessionId, status: 'running', cwd: '/secret/path', token: 'secret' }, entries,
}) as unknown as LiveSessionDetail
const get = (entries: unknown[], sessionId?: string) => vi.fn(() => detail(entries, sessionId))
const snapshot = (role: string, content: unknown, extra = {}) => ({ type: 'message', message: { role, content, ...extra }, path: '/secret/path' })
const event = (role: string, content: unknown) => ({ type: 'message_end', data: { message: { role, content, token: 'secret' } } })

describe('bounded machine preview projection', () => {
  it('selects only last eight completed user/assistant text messages in order', () => {
    const entries = [snapshot('user', 'old'), ...Array.from({ length: 9 }, (_, i) => event(i % 2 ? 'assistant' : 'user', `m${i}`)),
      snapshot('toolResult', 'secret'), event('system', 'secret'),
      { type: 'message_update', data: { message: { role: 'assistant', content: 'partial' } } },
      snapshot('assistant', [{ type: 'text', text: 'safe' }, { type: 'image', data: 'secret' }]),
      snapshot('assistant', { type: 'text', text: 'secret' }),
      snapshot('assistant', [{ type: 'thinking', text: 'secret' }]),
      snapshot('user', [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])]
    const preview = projectMachinePreview(get(entries), 'proc', 'current', () => 42)
    expect(preview).toEqual({ sessionId: 'current', status: 'running', observedAt: 42,
      messages: [...Array.from({ length: 7 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i + 2}` })), { role: 'user', text: 'hello world' }] })
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toMatch(/secret|path|token|partial|thinking|tool/)
  })
  it('truncates at code points and caps serialized preview even with escaped characters', () => {
    const entries = Array.from({ length: 8 }, () => event('assistant', '😀'.repeat(128) + 'extra'))
    const preview = projectMachinePreview(get(entries), 'proc', 'current')!
    expect(preview.messages).toHaveLength(8)
    expect(preview.messages.every(m => m.text === '😀'.repeat(128))).toBe(true)
    expect(projectMachinePreview(get([event('user', 'a'.repeat(511) + '😀')]), 'proc', 'current')!.messages[0].text).toBe('a'.repeat(511))
    const escaped = projectMachinePreview(get(Array.from({ length: 8 }, () => event('user', '\u0000'.repeat(512)))), 'proc', 'current')!
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(6144)
    expect(escaped.messages.every(m => Buffer.byteLength(m.text) <= 512)).toBe(true)
  })
  it('rejects stale, unattached and unsafe targets without reading details', () => {
    const lookup = get([event('user', 'private')], 'new')
    expect(projectMachinePreview(lookup, 'proc', 'old')).toBeUndefined()
    expect(projectMachinePreview(lookup, '../proc', 'new')).toBeUndefined()
    expect(projectMachinePreview(lookup, 'proc', 'x'.repeat(129))).toBeUndefined()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(projectMachinePreview(() => undefined, 'proc', 'new')).toBeUndefined()
  })
})
