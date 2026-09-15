/**
 * Tests for tmux-sessions.ts — pane environment passthrough and naming.
 *
 * The passthrough exists because tmux hands a pane the tmux *server's*
 * environment rather than the client's: dashboard-created live sessions used to
 * start with a stale environment and therefore showed a different model list
 * than terminal-started sessions.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  ensureUpdateEnvironment,
  panePassthroughEnv,
  readUpdateEnvironment,
  sanitizeTmuxSession,
} from '../tmux-sessions.js'

describe('sanitizeTmuxSession', () => {
  it('confines names to the pi-dash- namespace and rejects junk', () => {
    expect(sanitizeTmuxSession('live-abc')).toBe('pi-dash-live-abc')
    expect(sanitizeTmuxSession('pi-dash-live-abc')).toBe('pi-dash-live-abc')
    expect(() => sanitizeTmuxSession('bad name')).toThrow()
    expect(() => sanitizeTmuxSession('')).toThrow()
  })
})

describe('panePassthroughEnv', () => {
  it('carries provider credentials and endpoints over to the pane', () => {
    const names = panePassthroughEnv({
      DASHSCOPE_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_MODEL: 'm',
      AWS_PROFILE: 'p', AZURE_OPENAI_API_KEY: 'k', HF_TOKEN: 't',
    })
    expect(names).toEqual([
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'AWS_PROFILE', 'AZURE_OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'HF_TOKEN',
    ])
  })

  it('drops variables that describe the dashboard or the current pane', () => {
    const names = panePassthroughEnv({
      PI_RUNTIME: 'dashboard', PI_SLOT_KEY: 's', PI_SCRIPT: '/x.js', PI_DASH_PORT: '7777',
      PI_DASH_BRIDGE_SOCKET: '/s.sock', PI_DASH_BRIDGE_TOKEN: 't', PI_DASH_LIVE_SESSION_ORDER: '/o.json',
      // a fresh pane must not look like a resume of somebody's session
      PI_SESSION_FILE: '/s.jsonl', PI_SESSION_ID: 'abc',
      TMUX: '/tmp/x,1,0', TMUX_PANE: '%1', BASH_ENV_DIR: '/b',
      npm_config_user_agent: 'npm', CONDA_PREFIX: '/conda', _CE_M: '', NODE: '/usr/bin/node',
      PATH: '/usr/bin', HOME: '/home/u', USER: 'u', SHELL: '/bin/bash', PWD: '/p', OLDPWD: '/o', SHLVL: '1',
      TERM: 'xterm', LANG: 'C', LS_COLORS: 'x', NODE_OPTIONS: '--x', NODE_ENV: 'production', HOSTNAME: 'h', _: 'x', MAIL: '/m',
    })
    expect(names).toEqual([])
  })

  it('keeps other PI_* settings and TLS material that legitimately affect the Pi', () => {
    expect(panePassthroughEnv({ PI_BEDROCK_PROFILE: 'dev', NODE_EXTRA_CA_CERTS: '/ca.pem', HTTPS_PROXY: 'http://p' }))
      .toEqual(['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'PI_BEDROCK_PROFILE'])
  })
})

describe('readUpdateEnvironment', () => {
  it('parses the tmux array format', () => {
    const run = vi.fn(() => 'update-environment[0] DISPLAY\nupdate-environment[1] SSH_AUTH_SOCK\n')
    expect(readUpdateEnvironment(run)).toEqual(['DISPLAY', 'SSH_AUTH_SOCK'])
  })

  it('is empty when tmux cannot answer', () => {
    expect(readUpdateEnvironment(() => { throw new Error('no server') })).toEqual([])
  })
})

describe('ensureUpdateEnvironment', () => {
  it('unions with the existing list and writes once', () => {
    const calls = []
    const run = argv => {
      calls.push(argv)
      return argv[0] === 'show-options' ? 'update-environment[0] DISPLAY\n' : ''
    }
    ensureUpdateEnvironment(['DASHSCOPE_API_KEY', 'DISPLAY'], run)
    expect(calls).toEqual([
      ['show-options', '-g', 'update-environment'],
      ['set-option', '-g', 'update-environment', 'DISPLAY DASHSCOPE_API_KEY'],
    ])
  })

  it('does nothing when every name is already listed', () => {
    const run = vi.fn(() => 'update-environment[0] DISPLAY\nupdate-environment[1] DASHSCOPE_API_KEY\n')
    ensureUpdateEnvironment(['DISPLAY', 'DASHSCOPE_API_KEY'], run)
    expect(run.mock.calls.some(args => args[0][0] === 'set-option')).toBe(false)
  })

  it('ignores an empty name list', () => {
    const run = vi.fn(() => '')
    ensureUpdateEnvironment([], run)
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing on a cold machine and never blocks session creation', () => {
    // No server yet: creating the session starts it with our own environment.
    const cold = vi.fn(() => { throw new Error('no server running on /tmp/tmux-1001/default') })
    expect(() => ensureUpdateEnvironment(['DASHSCOPE_API_KEY'], cold)).not.toThrow()
    expect(cold.mock.calls.every(args => args[0][0] === 'show-options')).toBe(true)

    // Server exists but set-option fails: still must not throw.
    const broken = argv => argv[0] === 'show-options' ? 'update-environment[0] DISPLAY\n' : (() => { throw new Error('boom') })()
    expect(() => ensureUpdateEnvironment(['DASHSCOPE_API_KEY'], broken)).not.toThrow()
  })
})