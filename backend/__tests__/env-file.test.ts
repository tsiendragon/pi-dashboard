import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { dashboardEnvFilePaths, loadDashboardEnv, loadEnvFile, parseEnvFile } from '../env-file.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-dash-env-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseEnvFile', () => {
  it('reads KEY=VALUE, ignores comments and blanks, allows export and quotes', () => {
    const parsed = parseEnvFile(
      [
        '# comment',
        '',
        'PLAIN=value',
        'export EXPORTED=1',
        'QUOTED="has space"',
        "SINGLE='single'",
        'EMPTY=',
        'NOT A KEY=ignored',
        '=no-key',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      PLAIN: 'value',
      EXPORTED: '1',
      QUOTED: 'has space',
      SINGLE: 'single',
      EMPTY: '',
    })
  })
})

describe('loadEnvFile', () => {
  it('applies new variables but never overrides an existing one', () => {
    const file = join(dir, 'dash.env')
    writeFileSync(file, 'PI_TRACE_DIR=/tmp/traces\nDASHSCOPE_API_KEY=from-file\n')
    const env: NodeJS.ProcessEnv = { DASHSCOPE_API_KEY: 'already-set' }

    const applied = loadEnvFile(file, env)

    expect(applied).toEqual(['PI_TRACE_DIR'])
    expect(env.PI_TRACE_DIR).toBe('/tmp/traces')
    expect(env.DASHSCOPE_API_KEY).toBe('already-set')
  })

  it('treats an empty-string variable as unset', () => {
    const file = join(dir, 'dash.env')
    writeFileSync(file, 'PI_SCRIPT=/opt/pi/bin/pi\n')
    const env: NodeJS.ProcessEnv = { PI_SCRIPT: '' }

    expect(loadEnvFile(file, env)).toEqual(['PI_SCRIPT'])
    expect(env.PI_SCRIPT).toBe('/opt/pi/bin/pi')
  })
})

describe('dashboardEnvFilePaths / loadDashboardEnv', () => {
  it('loads the explicit PI_DASH_ENV_FILE', () => {
    const file = join(dir, 'explicit.env')
    writeFileSync(file, 'PI_TIMING_DIR=/tmp/timing\n')
    const env: NodeJS.ProcessEnv = { PI_DASH_ENV_FILE: file }

    const result = loadDashboardEnv(env)

    expect(result.files.map((f) => f.path)).toEqual([file])
    expect(result.files[0].applied).toEqual(['PI_TIMING_DIR'])
    expect(env.PI_TIMING_DIR).toBe('/tmp/timing')
    expect(result.error).toBeUndefined()
  })

  it('reports a requested but missing file instead of failing silently', () => {
    const env: NodeJS.ProcessEnv = { PI_DASH_ENV_FILE: join(dir, 'nope.env') }

    const result = loadDashboardEnv(env)

    expect(result.files).toEqual([])
    expect(result.error).toContain('nope.env')
  })

  it('picks up <PI_CODING_AGENT_DIR>/dashboard.env', () => {
    const agent = join(dir, 'agent')
    mkdirSync(agent, { recursive: true })
    writeFileSync(join(agent, 'dashboard.env'), 'PI_OBSERVATION_DIR=/tmp/obs\n')

    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: agent }

    expect(dashboardEnvFilePaths(env)).toContain(join(agent, 'dashboard.env'))
    const result = loadDashboardEnv(env)
    expect(env.PI_OBSERVATION_DIR).toBe('/tmp/obs')
    expect(result.files.some((f) => f.path.endsWith('dashboard.env'))).toBe(true)
  })
})