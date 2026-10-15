import { describe, expect, it, vi } from 'vitest'
import { LiveSessionRestarter, isRestartProcessAlive } from '../live-sessions/session-restart.js'

const tmuxSession = 'pi-dash-live-abc12345'
function makeFixture({ overrides = {}, childSessions = [], exits = true, fileExists = true, panePid = 42 } = {}) {
  const state = { attached: true, processAlive: true, tmuxAlive: true }
  const summary = {
    processInstanceId: 'process-a', sessionId: 'session-a', pid: 42,
    cwd: '/work/app', canonicalCwd: '/work/app', mode: 'tui', status: 'idle',
    capabilities: [], sessionFile: '/home/user/.pi/sessions/session-a.jsonl',
    sessionName: 'App session', ...overrides,
  }
  const registry = {
    get: vi.fn(() => state.attached ? { summary } : undefined),
    list: vi.fn(() => childSessions), dispatch: vi.fn(),
  }
  const quitPi = vi.fn(() => {
    if (exits) Object.assign(state, { attached: false, processAlive: false, tmuxAlive: false })
  })
  const launcher = { start: vi.fn(async () => {
    expect(state.processAlive).toBe(false)
    expect(state.tmuxAlive).toBe(false)
    return { processInstanceId: 'process-b', sessionId: 'session-a' }
  }) }
  const restarter = new LiveSessionRestarter({
    registry, launcher, quitPi,
    metaStore: { list: async () => ({ 'session-a': { tmux: tmuxSession } }) },
    hasTmuxSession: () => state.tmuxAlive, tmuxPanePid: () => panePid,
    isProcessAlive: () => state.processAlive, fileExists: async () => fileExists,
    sleep: async () => {}, exitTimeoutMs: exits ? 100 : 0,
  })
  return { restarter, quitPi, registry, launcher }
}

describe('LiveSessionRestarter', () => {
  it('sends /quit through the TUI, then resumes the original file without a shutdown capability', async () => {
    const { restarter, quitPi, registry, launcher } = makeFixture()
    await expect(restarter.restart('process-a')).resolves.toMatchObject({ sessionId: 'session-a' })
    expect(quitPi).toHaveBeenCalledWith(tmuxSession)
    expect(registry.dispatch).not.toHaveBeenCalled()
    expect(launcher.start).toHaveBeenCalledWith({
      cwd: '/work/app', title: 'App session', sessionFile: '/home/user/.pi/sessions/session-a.jsonl',
    })
  })
  it('runs the post-stop hook before resuming, and still resumes when the hook fails', async () => {
    const { restarter, launcher } = makeFixture()
    const hookError = new Error('could not commit staged session')
    const afterPiStopped = vi.fn(async () => { throw hookError })
    await expect(restarter.restart('process-a', undefined, afterPiStopped)).resolves.toMatchObject({ afterPiStoppedError: hookError })
    expect(afterPiStopped).toHaveBeenCalledOnce()
    expect(launcher.start).toHaveBeenCalledWith({
      cwd: '/work/app', title: 'App session', sessionFile: '/home/user/.pi/sessions/session-a.jsonl',
    })
  })
  it('rejects a stale session id before sending /quit', async () => {
    const { restarter, quitPi, launcher } = makeFixture()
    await expect(restarter.restart('process-a', 'old-session')).rejects.toMatchObject({ code: 'session_changed' })
    expect(quitPi).not.toHaveBeenCalled()
    expect(launcher.start).not.toHaveBeenCalled()
  })
  it.each([
    [{ overrides: { status: 'running' } }, 'session_not_restartable'],
    [{ panePid: 99 }, 'session_process_identity_mismatch'],
    [{ fileExists: false }, 'session_file_unavailable'],
    [{ childSessions: [{ role: 'subagent', parentSessionId: 'session-a' }] }, 'session_has_live_subagents'],
  ])('keeps pre-quit safety checks for %j', async (options, code) => {
    const { restarter, quitPi, launcher } = makeFixture(options)
    await expect(restarter.restart('process-a')).rejects.toMatchObject({ code })
    expect(quitPi).not.toHaveBeenCalled()
    expect(launcher.start).not.toHaveBeenCalled()
  })
  it('does not start a replacement when /quit does not exit', async () => {
    const { restarter, quitPi, launcher } = makeFixture({ exits: false })
    await expect(restarter.restart('process-a')).rejects.toMatchObject({ code: 'restart_exit_timeout' })
    expect(quitPi).toHaveBeenCalledOnce()
    expect(launcher.start).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform !== 'linux')('restart process state', () => {
  it.each(['Z', 'X'])('treats %s as exited even when the PID exists', state => {
    expect(isRestartProcessAlive(process.pid, () => `${process.pid} (pi worker) ${state} 1`)).toBe(false)
  })
  it('keeps a running process alive', () => {
    expect(isRestartProcessAlive(process.pid, () => `${process.pid} (pi) S 1`)).toBe(true)
  })
  it('handles a process disappearing during the stat read', () => {
    expect(isRestartProcessAlive(process.pid, () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })).toBe(false)
  })
  it('does not hide unexpected stat errors', () => {
    expect(() => isRestartProcessAlive(process.pid, () => { throw new Error('read failed') })).toThrow('read failed')
  })
})
