/**
 * Tests for live-sessions/launcher.ts — tmux-first live Pi sessions.
 *
 * The launcher never spawns tmux itself here: the session factory, the kill
 * hook, the pane-pid probe and the clock are all injected, so the whole
 * lifecycle (argv/env, wait-for-registration, timeout rollback, path policy) is
 * asserted without touching a real tmux server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LivePiLauncher, paneEnvironment, paneLaunchArgv } from '../live-sessions/launcher.js'
import { sanitizeTmuxSession } from '../tmux-sessions.js'
import { parseLiveSessionConfig } from '../live-sessions/config.js'

function summary(over = {}) {
  return {
    processInstanceId: 'pi-1',
    sessionId: 'session-1',
    canonicalCwd: '/tmp/root/app',
    startedAt: 1,
    pid: 1001,
    ...over,
  }
}

/**
 * A registry whose first call (the launcher's pre-scan) returns only sessions
 * that already existed, and whose later calls also return the one that just
 * registered. Reusing a single object for both calls would mark the new session
 * as pre-existing and the launcher would correctly ignore it.
 */
function registeringRegistry(existing, fresh = []) {
  let calls = 0
  return {
    list: () => {
      calls += 1
      return calls > 1 ? [...existing, ...fresh] : [...existing]
    },
  }
}

function makeLauncher({ roots, registry, over = {} } = {}) {
  const created = []
  const killed = []
  const launcher = new LivePiLauncher({
    registry,
    roots,
    createSession: (name, options) => { created.push({ name, options }); return sanitizeTmuxSession(name) },
    killSession: name => { killed.push(name) },
    panePid: () => undefined,
    piCommand: '/usr/bin/pi',
    registrationTimeoutMs: 200,
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
    ...over,
  })
  return { launcher, created, killed }
}

describe('paneEnvironment', () => {
  it('forces live runtime and clears dashboard slot identity', () => {
    expect(paneEnvironment()).toMatchObject({ PI_RUNTIME: 'live' })
    expect(paneEnvironment().PI_SLOT_KEY).toBe('')
    expect(paneEnvironment().PI_DASH_BRIDGE_SOCKET).toBe('')
  })
})

describe('LivePiLauncher.start', () => {
  let dir, app
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-launch-'))
    app = join(dir, 'app')
    mkdirSync(app)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates a namespaced tmux session in the target cwd with the chosen model/thinking/title', async () => {
    const registry = registeringRegistry([], [summary({ canonicalCwd: app, processInstanceId: 'pi-new', sessionId: 'session-new' })])
    const { launcher, created } = makeLauncher({ roots: [dir], registry })

    const result = await launcher.start({
      cwd: app, modelProvider: 'dashscope', modelId: 'qwen3-coder-plus', thinkingLevel: 'high', title: '冷启动 分析',
    })

    expect(created).toHaveLength(1)
    expect(created[0].name).toMatch(/^live-[0-9a-f]{8}$/)
    expect(result.tmuxSession).toMatch(/^pi-dash-live-[0-9a-f]{8}$/)
    expect(created[0].options.cwd).toBe(app)
    expect(created[0].options.command).toBe('/usr/bin/pi')
    expect(created[0].options.env.PI_RUNTIME).toBe('live')
    // Title with a space must survive as one argv entry.
    expect(created[0].options.args).toEqual([
      '--model', 'dashscope/qwen3-coder-plus', '--thinking', 'high', '--name', '冷启动 分析',
    ])
  })

  it('omits model/thinking flags when they were not requested', async () => {
    const registry = registeringRegistry([], [summary({ canonicalCwd: app, processInstanceId: 'pi-new', sessionId: 'session-new' })])
    const { launcher, created } = makeLauncher({ roots: [dir], registry })
    const result = await launcher.start({ cwd: app })
    expect(created[0].options.args).toEqual(['--name', `Live · ${join(app).split('/').pop()}`])
    expect(result.title).toBe(`Live · app`)
  })

  it('returns the session that registers after the launch, ignoring pre-existing sessions', async () => {
    const existing = summary({ processInstanceId: 'pi-old', sessionId: 'session-old', canonicalCwd: app, startedAt: 1 })
    let next = 0
    const registry = {
      list: () => {
        next += 1
        return next > 2 ? [existing, summary({ processInstanceId: 'pi-new', sessionId: 'session-new', canonicalCwd: app, startedAt: 9 })] : [existing]
      },
    }
    const { launcher } = makeLauncher({ roots: [dir], registry })
    const result = await launcher.start({ cwd: app })
    expect(result).toMatchObject({ sessionId: 'session-new', processInstanceId: 'pi-new' })
  })

  it('prefers the pane pid when several new sessions share the cwd', async () => {
    const registry = registeringRegistry([], [
      summary({ processInstanceId: 'pi-a', sessionId: 'session-a', canonicalCwd: app, startedAt: 5, pid: 111 }),
      summary({ processInstanceId: 'pi-b', sessionId: 'session-b', canonicalCwd: app, startedAt: 9, pid: 222 }),
    ])
    const { launcher } = makeLauncher({ roots: [dir], registry, over: { panePid: () => 111 } })
    expect(await launcher.start({ cwd: app })).toMatchObject({ sessionId: 'session-a' })
  })

  it('kills the tmux session and fails when nothing registers in time', async () => {
    const registry = { list: () => [] }
    const { launcher, killed } = makeLauncher({ roots: [dir], registry })
    await expect(launcher.start({ cwd: app })).rejects.toThrow(/live_pi_registration_timeout/)
    expect(killed).toEqual([expect.stringMatching(/^pi-dash-live-/)])
  })

  it('never reuses an existing tmux name, and reports a missing tmux binary clearly', async () => {
    const registry = { list: () => [] }
    const taken = makeLauncher({ roots: [dir], registry, over: { sessionExists: () => true } })
    await expect(taken.launcher.start({ cwd: app })).rejects.toThrow(/could not create a tmux session/)
    expect(taken.created).toEqual([])

    const noTmux = makeLauncher({
      roots: [dir], registry,
      over: { createSession: () => { throw Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' }) } },
    })
    await expect(noTmux.launcher.start({ cwd: app })).rejects.toThrow(/tmux_unavailable/)
  })

  it('rejects a cwd outside the configured roots without touching tmux', async () => {
    const registry = { list: () => [] }
    const { launcher, created } = makeLauncher({ roots: [dir], registry })
    await expect(launcher.start({ cwd: tmpdir() })).rejects.toThrow(/outside configured roots/)
    expect(created).toEqual([])
  })

  it('names the real problem when the cwd is wrong', async () => {
    const registry = { list: () => [] }
    const { launcher, created } = makeLauncher({ roots: [dir], registry })
    const missing = join(dir, 'gone')
    await expect(launcher.start({ cwd: missing })).rejects.toThrow(new RegExp(`cwd does not exist: ${missing}`))

    const file = join(dir, 'app', 'not-a-dir.txt')
    writeFileSync(file, 'x')
    await expect(launcher.start({ cwd: file })).rejects.toThrow(/cwd is not a directory/)

    const outside = join(dir, '..')
    await expect(launcher.start({ cwd: outside })).rejects.toThrow(/cwd is outside configured roots: .* is not under /)

    await expect(launcher.start({ cwd: 'relative/dir' })).rejects.toThrow(/cwd must be absolute/)
    expect(created).toEqual([])
  })

  it('validates thinking level and the model pair before launching', async () => {
    const registry = { list: () => [] }
    const { launcher, created } = makeLauncher({ roots: [dir], registry })
    await expect(launcher.start({ cwd: app, thinkingLevel: 'ludicrous' })).rejects.toThrow('invalid_thinking_level')
    await expect(launcher.start({ cwd: app, modelProvider: 'dashscope' })).rejects.toThrow('model_id_required')
    await expect(launcher.start({ cwd: app, modelId: 'qwen3-coder-plus' })).rejects.toThrow('model_provider_required')
    expect(created).toEqual([])
  })

  it('expands ~ and ~/ prefixed cwds', async () => {
    const home = process.env.HOME
    const registry = registeringRegistry([], [summary({ canonicalCwd: home, processInstanceId: 'pi-new', sessionId: 'session-new' })])
    const { launcher, created } = makeLauncher({ roots: [home], registry })
    await launcher.start({ cwd: '~/', title: undefined })
    expect(created[0].options.cwd).toBe(await realpathOr(home))
  })
})

async function realpathOr(p) {
  const { realpath } = await import('fs/promises')
  return realpath(p)
}

describe('configured launcher (pi-clean style wrapper)', () => {
  let dir, app
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-launch-cfg-'))
    app = join(dir, 'app')
    mkdirSync(app)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const startWith = async (launch) => {
    const registry = registeringRegistry([], [summary({ canonicalCwd: app, processInstanceId: 'pi-new', sessionId: 'session-new' })])
    const { launcher, created } = makeLauncher({ roots: [dir], registry, over: { launch } })
    await launcher.start({ cwd: app, title: 'T' })
    return created[0].options
  }

  it('runs the configured wrapper and appends the dashboard arguments after its own', async () => {
    const options = await startWith({ command: '/home/u/.local/bin/pi-clean', args: ['--goal-continuation'], unsetEnv: [] })
    expect(options.command).toBe('/home/u/.local/bin/pi-clean')
    expect(options.args).toEqual(['--goal-continuation', '--name', 'T'])
  })

  it('removes the configured credentials with env -u instead of blanking them', async () => {
    const options = await startWith({
      command: '/home/u/.local/bin/pi-clean',
      args: [],
      unsetEnv: ['HF_TOKEN', 'AZURE_OPENAI_API_KEY'],
    })
    expect(options.command).toBe('env')
    expect(options.args).toEqual(['-u', 'HF_TOKEN', '-u', 'AZURE_OPENAI_API_KEY', '/home/u/.local/bin/pi-clean', '--name', 'T'])
  })

  it('falls back to the plain pi launcher when nothing is configured', async () => {
    const options = await startWith(undefined)
    expect(options.command).toBe('/usr/bin/pi')
    expect(options.args).toEqual(['--name', 'T'])
  })
})

describe('parseLiveSessionConfig launch section', () => {
  it('defaults to no wrapper, no extra args and no unset list', () => {
    const cfg = parseLiveSessionConfig({ enabled: true, roots: ['/tmp'] })
    expect(cfg.launch).toEqual({ args: [], unsetEnv: [] })
  })

  it('reads the wrapper, its args and the unset list', () => {
    const cfg = parseLiveSessionConfig({
      roots: ['/tmp'],
      launch: {
        command: '  /home/u/.local/bin/pi-clean  ',
        args: ['--goal-continuation', 42],
        unsetEnv: ['HF_TOKEN', 'HF_TOKEN', 'BAD NAME', 'AZURE_OPENAI_API_KEY'],
      },
    })
    expect(cfg.launch).toEqual({
      command: '/home/u/.local/bin/pi-clean',
      args: ['--goal-continuation'],
      unsetEnv: ['HF_TOKEN', 'AZURE_OPENAI_API_KEY'],
    })
  })

  it('ignores a blank command and a non-object launch block', () => {
    expect(parseLiveSessionConfig({ roots: ['/tmp'], launch: { command: '   ' } }).launch.command).toBeUndefined()
    expect(parseLiveSessionConfig({ roots: ['/tmp'], launch: 'pi-clean' }).launch).toEqual({ args: [], unsetEnv: [] })
  })
})

describe('paneLaunchArgv', () => {
  it('leaves argv untouched without an unset list', () => {
    expect(paneLaunchArgv({ command: 'pi', args: ['--name', 'x'], unsetEnv: [] }))
      .toEqual({ command: 'pi', args: ['--name', 'x'] })
  })

  it('prefixes env -u for every unset variable', () => {
    expect(paneLaunchArgv({ command: 'pi-clean', args: ['--name', 'x'], unsetEnv: ['A', 'B'] }))
      .toEqual({ command: 'env', args: ['-u', 'A', '-u', 'B', 'pi-clean', '--name', 'x'] })
  })
})

describe('LivePiLauncher.stop', () => {
  it('shuts the legacy manager down but never kills tmux sessions', async () => {
    const gracefulShutdown = vi.fn(async () => {})
    const killed = []
    const launcher = new LivePiLauncher({
      registry: { list: () => [] },
      roots: [],
      manager: { gracefulShutdown },
      killSession: name => { killed.push(name) },
    })
    await launcher.stop()
    expect(gracefulShutdown).toHaveBeenCalled()
    expect(killed).toEqual([])
  })
})