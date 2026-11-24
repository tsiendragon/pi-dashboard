import express from 'express'
import { createServer } from 'http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerModelConfigRoutes } from '../routes/model-config.js'

describe('model config routes', () => {
  let dir: string
  let server: ReturnType<typeof createServer>
  let base: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-model-config-'))
    process.env.PI_CODING_AGENT_DIR = dir
    writeFileSync(join(dir, 'models.json'), JSON.stringify({
      providers: {
        dashscope: { baseUrl: 'https://dashscope.example/v1', api: 'openai-completions', apiKey: '$DASHSCOPE_API_KEY', models: [{ id: 'old', name: 'Old', contextWindow: 1000, maxTokens: 100 }] },
        'openai-codex': { models: [] },
      },
    }, null, 2))
    const app = express()
    app.use(express.json())
    const auth = {
      isOriginAllowed: () => true,
      getIdentity: () => ({ browserClientId: 'test-client' }),
    }
    registerModelConfigRoutes({ app, auth: auth as never })
    await new Promise<void>(resolve => { server = createServer(app); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.PI_CODING_AGENT_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('redacts keys while exposing configured status and models', async () => {
    const response = await fetch(`${base}/api/model-config/providers`)
    expect(response.status).toBe(200)
    const body = await response.json() as { providers: Array<Record<string, unknown>> }
    const dash = body.providers.find(provider => provider.id === 'dashscope')!
    expect(dash).toMatchObject({ hasKey: true, keySource: 'env', api: 'openai-completions' })
    expect(JSON.stringify(body)).not.toContain('DASHSCOPE_API_KEY=')
  })

  it('saves a custom provider/model and appends it to an enabledModels allowlist', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledModels: ['other/*'] }))
    const response = await fetch(`${base}/api/model-config/providers/custom`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai-completions',
        baseUrl: 'https://llm.example/v1/',
        apiKey: 'sk-test-secret',
        models: [{ id: 'my-model', name: 'My Model', contextWindow: 32000, maxTokens: 4096, reasoning: true, input: ['text', 'image'] }],
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { provider: Record<string, unknown>; allowlistChanged: boolean }
    expect(body.provider).toMatchObject({ id: 'custom', hasKey: true, keySource: 'stored' })
    expect(JSON.stringify(body)).not.toContain('sk-test-secret')
    expect(body.allowlistChanged).toBe(true)
    const file = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))
    expect(file.providers.custom.models[0]).toMatchObject({ id: 'my-model', contextWindow: 32000 })
    expect(file.providers.custom.apiKey).toBe('sk-test-secret')
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(settings.enabledModels).toContain('custom/my-model')
  })

  it('preserves an existing key when the edit leaves the key blank', async () => {
    const response = await fetch(`${base}/api/model-config/providers/dashscope`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api: 'openai-completions',
        baseUrl: 'https://dashscope.example/v1',
        models: [{ id: 'new', name: 'New', contextWindow: 2000, maxTokens: 200 }],
      }),
    })
    expect(response.status).toBe(200)
    const file = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))
    expect(file.providers.dashscope.apiKey).toBe('$DASHSCOPE_API_KEY')
    expect(file.providers.dashscope.models.map((model: { id: string }) => model.id)).toEqual(['new'])
  })

  it('rejects unsafe provider, URL and API values', async () => {
    for (const input of [
      { api: 'openai-completions', baseUrl: 'file:///tmp/x', models: [] },
      { api: 'unknown', baseUrl: 'https://example.test/v1', models: [] },
      { api: 'openai-completions', baseUrl: 'https://example.test/v1', models: [{ id: 'bad model' }] },
    ]) {
      const response = await fetch(`${base}/api/model-config/providers/custom`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      })
      expect(response.status).toBe(400)
    }
  })
})
