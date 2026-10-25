import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerSubagentModelsRoutes } from '../routes/subagent-models.js'

const baseConfig = () => ({
  version: 1,
  defaultTier: 'light',
  roles: { read_only: 'light', research: 'medium', code: 'heavy' },
  allowInherit: false,
  futureKey: { keep: true },
  tiers: {
    light: { candidates: [{ model: 'p/a' }], onExhausted: { action: 'escalate', escalateTo: 'medium' } },
    medium: { candidates: [{ model: 'p/b', thinking: 'low', maxConcurrency: 2 }] },
    heavy: { candidates: [] },
    ultra: { candidates: [] },
  },
})

let dir: string
let server: Server
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'subagent-models-'))
  const app = express()
  app.use(express.json())
  const auth = { isOriginAllowed: () => true, getIdentity: () => ({}) } as never
  registerSubagentModelsRoutes({ app, manager: { getModels: async () => [{ provider: 'p', id: 'a' }] }, auth, agentDir: () => dir })
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/subagent-models`
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const put = (body: unknown) => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('/api/subagent-models', () => {
  it('GET returns null config when file is missing', async () => {
    const data = await (await fetch(base)).json()
    expect(data.config).toBeNull()
    expect(data.path).toBe(join(dir, 'subagent-models.json'))
  })

  it('GET returns config and warnings; PUT writes, backs up, keeps unknown keys', async () => {
    const file = join(dir, 'subagent-models.json')
    writeFileSync(file, JSON.stringify(baseConfig()))
    const got = await (await fetch(base)).json()
    expect(got.warnings.join('|')).toMatch(/p\/b.*not in the model catalog/)
    expect(got.warnings.join('|')).toMatch(/empty/)
    const next = got.config
    next.tiers.heavy.candidates.push({ model: 'p/a2' })
    const res = await put({ config: next, baseMtimeMs: got.mtimeMs })
    expect(res.status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf-8')).futureKey).toEqual({ keep: true })
    expect(readdirSync(join(dir, 'backups')).length).toBe(1)
  })

  it('PUT returns 409 when the file changed since baseMtimeMs', async () => {
    const file = join(dir, 'subagent-models.json')
    writeFileSync(file, JSON.stringify(baseConfig()))
    const got = await (await fetch(base)).json()
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    const res = await put({ config: got.config, baseMtimeMs: got.mtimeMs })
    expect(res.status).toBe(409)
  })

  it('PUT returns 400 for a model in two tiers', async () => {
    const cfg = baseConfig()
    cfg.tiers.heavy.candidates.push({ model: 'p/a' } as never)
    const res = await put({ config: cfg, baseMtimeMs: null })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/duplicate model p\/a/)
  })

  it('PUT returns 400 when automatic escalation targets heavy or ultra', async () => {
    const cfg = baseConfig()
    cfg.tiers.light.onExhausted.escalateTo = 'ultra'
    const res = await put({ config: cfg, baseMtimeMs: null })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/escalateTo must be light or medium/)
  })
})
