import { describe, it, expect } from 'vitest'
import { sanitizeTmuxSession, PTY_SESSION_PREFIX } from '../tmux-sessions.js'

describe('sanitizeTmuxSession', () => {
  it('keeps valid names inside the pi-dash- namespace', () => {
    expect(sanitizeTmuxSession('default')).toBe('pi-dash-default')
    expect(sanitizeTmuxSession('my_session-01')).toBe('pi-dash-my_session-01')
    expect(sanitizeTmuxSession('ABC_123')).toBe('pi-dash-ABC_123')
  })

  it('does not double-prefix an already-prefixed name', () => {
    expect(sanitizeTmuxSession('pi-dash-default')).toBe('pi-dash-default')
  })

  it('rejects unsafe or empty names', () => {
    const bad = [
      '',
      '   ',
      'a b',
      'a;b',
      'a|b',
      'a.b',
      '../x',
      'a/b',
      '${HOME}',
      '`id`',
      'a\nb',
      'pi-dash-',
      'a'.repeat(65),
    ]
    for (const name of bad) {
      expect(() => sanitizeTmuxSession(name), `should reject: ${JSON.stringify(name)}`).toThrow()
    }
  })

  it('exports the expected namespace prefix', () => {
    expect(PTY_SESSION_PREFIX).toBe('pi-dash-')
  })
})