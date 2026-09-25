/**
 * Validation tests for the live-session `feature_command` channel.
 *
 * The dashboard command bar can move a running foreground command to the
 * background; that rides the existing lease-gated `feature_command` channel
 * rather than a new command type, so the whitelist is asserted here.
 */
import { describe, expect, it } from 'vitest'
import { validateLiveSessionCommand } from '../live-sessions/protocol.js'

describe('feature_command validation', () => {
  it('accepts the background-commands handoff command', () => {
    const command = {
      type: 'feature_command',
      leaseId: 'lease-1',
      feature: 'background-commands',
      command: { type: 'background', toolCallId: 'toolu_01abc' },
    }
    expect(validateLiveSessionCommand(command, true)).toMatchObject(command)
  })

  it('rejects a handoff command without a usable tool call id', () => {
    for (const payload of [
      { type: 'feature_command', leaseId: 'lease-1', feature: 'background-commands', command: { type: 'background' } },
      { type: 'feature_command', leaseId: 'lease-1', feature: 'background-commands', command: { type: 'background', toolCallId: '' } },
      { type: 'feature_command', leaseId: 'lease-1', feature: 'background-commands', command: { type: 'background', toolCallId: 'x'.repeat(513) } },
      { type: 'feature_command', leaseId: 'lease-1', feature: 'background-commands', command: { type: 'cancel', toolCallId: 'toolu_1' } },
    ]) {
      expect(() => validateLiveSessionCommand(payload, true)).toThrow(/invalid or unsupported/)
    }
  })

  it('keeps rejecting unknown features and extra fields', () => {
    expect(() => validateLiveSessionCommand(
      { type: 'feature_command', leaseId: 'lease-1', feature: 'shell', command: { type: 'background', toolCallId: 'toolu_1' } },
      true,
    )).toThrow(/invalid or unsupported/)
    expect(() => validateLiveSessionCommand(
      { type: 'feature_command', leaseId: 'lease-1', feature: 'background-commands', command: { type: 'background', toolCallId: 'toolu_1', extra: 1 } },
      true,
    )).toThrow(/invalid or unsupported/)
  })

  it('still accepts the existing btw open/close command', () => {
    const command = { type: 'feature_command', leaseId: 'lease-1', feature: 'btw', command: { type: 'open' } }
    expect(validateLiveSessionCommand(command, true)).toMatchObject(command)
  })

  it('accepts the btw side-chat surface the dashboard panel uses', () => {
    for (const btwCommand of [
      { type: 'close' },
      { type: 'abort' },
      { type: 'refresh-parent' },
      { type: 'submit', text: '这个报错是哪里来的？' },
    ]) {
      const command = { type: 'feature_command', leaseId: 'lease-1', feature: 'btw', command: btwCommand }
      expect(validateLiveSessionCommand(command, true)).toMatchObject(command)
    }
  })

  it('rejects a btw submit without usable text or with extra fields', () => {
    for (const btwCommand of [
      { type: 'submit' },
      { type: 'submit', text: '' },
      { type: 'submit', text: 'hi', extra: 1 },
      { type: 'submit', text: 'x'.repeat(128 * 1024 + 1) },
      { type: 'restart' },
    ]) {
      expect(() => validateLiveSessionCommand(
        { type: 'feature_command', leaseId: 'lease-1', feature: 'btw', command: btwCommand },
        true,
      )).toThrow(/invalid or unsupported/)
    }
  })
})
