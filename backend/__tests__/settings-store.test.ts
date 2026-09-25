import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsStore } from '../settings-store.js'

let dir: string
let store: SettingsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-dash-settings-'))
  store = new SettingsStore(() => dir)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', extensions: ['/a.ts'] }, null, 2), 'utf-8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const read = () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))

describe('SettingsStore', () => {
  it('backs up the previous file and writes atomically', async () => {
    const outcome = await store.mutate((settings, save) => {
      settings['extensions'] = ['-/a.ts']
      save(settings)
    })
    expect(outcome.changed).toBe(true)
    expect(outcome.backupPath).toBeTruthy()
    expect(JSON.parse(readFileSync(outcome.backupPath!, 'utf-8'))).toEqual({ theme: 'dark', extensions: ['/a.ts'] })
    expect(read()).toEqual({ theme: 'dark', extensions: ['-/a.ts'] })
    // unrelated keys survive, and no temp files are left behind
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('skips the write entirely when the mutator does not call save', async () => {
    const outcome = await store.mutate(() => undefined)
    expect(outcome.changed).toBe(false)
    expect(outcome.backupPath).toBeNull()
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('serializes concurrent mutations so none are lost', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        store.mutate((settings, save) => {
          const list = Array.isArray(settings['list']) ? (settings['list'] as number[]) : []
          settings['list'] = [...list, index]
          save(settings)
        }),
      ),
    )
    const list = read()['list'] as number[]
    expect(list.length).toBe(12)
    expect([...list].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_value, index) => index))
  })

  it('keeps working when settings.json is malformed or missing', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ broken', 'utf-8')
    expect(store.read()).toEqual({})
    const outcome = await store.mutate((settings, save) => {
      settings['theme'] = 'light'
      save(settings)
    })
    expect(outcome.changed).toBe(true)
    expect(read()).toEqual({ theme: 'light' })
    rmSync(join(dir, 'settings.json'))
    expect(store.read()).toEqual({})
  })
})
