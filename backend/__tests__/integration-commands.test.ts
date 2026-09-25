/**
 * Dashboard-side validation for `background-commands` integration commands.
 *
 * The dashboard only forwards command types that are explicitly allow-listed;
 * the "move to background" handoff added for foreground bash is covered here so
 * a malformed payload is rejected in the backend instead of the extension.
 */
import { describe, expect, it } from 'vitest'
import { validateCommand } from '../routes/integrations.js'

describe('background-commands integration commands', () => {
  it('accepts a background handoff command with a tool call id', () => {
    expect(validateCommand('background-commands', { type: 'background', toolCallId: 'toolu_01abc' })).toBeUndefined()
  })

  it('rejects a background handoff command without a usable tool call id', () => {
    expect(validateCommand('background-commands', { type: 'background' })).toBe('invalid tool call id')
    expect(validateCommand('background-commands', { type: 'background', toolCallId: '' })).toBe('invalid tool call id')
    expect(validateCommand('background-commands', { type: 'background', toolCallId: '   ' })).toBe('invalid tool call id')
    expect(validateCommand('background-commands', { type: 'background', toolCallId: 'x'.repeat(257) })).toBe('invalid tool call id')
  })

  it('still rejects commands that are not allow-listed', () => {
    expect(validateCommand('background-commands', { type: 'start', command: 'echo hi' })).toBe('unsupported background-commands command')
  })

  it('keeps existing refresh/output/cancel validation', () => {
    expect(validateCommand('background-commands', { type: 'refresh' })).toBeUndefined()
    expect(validateCommand('background-commands', { type: 'cancel', taskId: 'bash-a1b2' })).toBeUndefined()
    expect(validateCommand('background-commands', { type: 'cancel', taskId: 'not-a-task' })).toBe('invalid background task id')
  })
})
