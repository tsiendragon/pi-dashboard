import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('child_process', () => ({ execFileSync, execSync: vi.fn() }))
import { quitTmuxPi } from '../tmux-sessions.js'

const dir = mkdtempSync(join(tmpdir(), 'pi-quit-keys-'))
const config = join(dir, 'keybindings.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => execFileSync.mockReset())

describe('quitTmuxPi', () => {
  it.each([
    [{}, 'Enter'],
    [{ 'tui.input.newLine': ['enter'], 'tui.input.submit': ['ctrl+r', 'f12'] }, 'C-r'],
    [{ 'tui.input.submit': ['f12'] }, 'F12'],
  ])('honors configured submit keys: %j', (bindings, submit) => {
    writeFileSync(config, JSON.stringify(bindings))
    quitTmuxPi('pi-dash-live-abc12345', config)
    expect(execFileSync.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['tmux', ['send-keys', '-t', 'pi-dash-live-abc12345:0.0', 'C-c']],
      ['tmux', ['send-keys', '-t', 'pi-dash-live-abc12345:0.0', '-l', '/quit']],
      ['tmux', ['send-keys', '-t', 'pi-dash-live-abc12345:0.0', submit]],
    ])
  })
  it('uses defaults when the file is absent', () => {
    quitTmuxPi('pi-dash-live-abc12345', join(dir, 'missing.json'))
    expect(execFileSync.mock.calls.at(-1)[1].at(-1)).toBe('Enter')
  })
  it.each([[[]], [['shift+unknown']]])('rejects unusable submit bindings before touching the pane: %j', keys => {
    writeFileSync(config, JSON.stringify({ 'tui.input.submit': keys }))
    expect(() => quitTmuxPi('pi-dash-live-abc12345', config)).toThrow('no supported tmux key')
    expect(execFileSync).not.toHaveBeenCalled()
  })
  it('does not hide malformed configuration', () => {
    writeFileSync(config, '{broken')
    expect(() => quitTmuxPi('pi-dash-live-abc12345', config)).toThrow()
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
