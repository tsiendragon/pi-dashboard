import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { generateMeme, MEME_MAX_REFERENCE_BYTES, memeProviders } from '../memes.js'
import { registerMemeRoutes } from '../routes/memes.js'
import { MEME_MODELS, resourceFingerprint } from '../meme-models.js'
import { memeModelChecks } from '../meme-model-checks.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const IMAGE = `data:image/png;base64,${PNG}`
const REMOTE_IMAGE = 'https://images.example.com/meme.png?signature=test'
const nativeFetch = globalThis.fetch

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
function dashResult() {
  return json({ output: { choices: [{ message: { content: [{ image: REMOTE_IMAGE }] } }] } })
}
function configured() {
  vi.stubEnv('DASHSCOPE_API_KEY', 'test-dash-secret')
  vi.stubEnv('DASHSCOPE_IMAGE_ENDPOINT', 'https://dashscope.example.com/generate')
  vi.stubEnv('DASHSCOPE_IMAGE_MODEL', 'qwen-image-max')
  vi.stubEnv('DASHSCOPE_IMAGE_EDIT_MODEL', 'qwen-image-edit')
  vi.stubEnv('AZURE_OPENAI_IMAGE_API_KEY', 'test-azure-secret')
  vi.stubEnv('AZURE_OPENAI_IMAGE_ENDPOINT', 'https://azure.example.com/')
  vi.stubEnv('AZURE_OPENAI_IMAGE_DEPLOYMENT', 'my-gpt-image')
  vi.stubEnv('AZURE_OPENAI_IMAGE_API_VERSION', '2025-04-01-preview')
  vi.stubEnv('AZURE_OPENAI_IMAGE_AUTH', 'bearer')
}

beforeEach(configured)
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('image service contracts', () => {
  it('does not expose private resource scope or reuse checks for another resource', () => {
    const key = 'azure/gpt-image-2.5-sunburst'
    const previous = memeModelChecks[key]
    const fingerprint = resourceFingerprint('https://azure.example.com')
    memeModelChecks[key] = { t2i: { status: 'passed', resourceFingerprint: fingerprint, checkedAt: '2026-10-18' } }
    try {
      const model = memeProviders()[1]!.models.find(item => item.id === 'gpt-image-2.5-sunburst')!
      expect(model.verification.t2i.status).toBe('passed')
      expect(JSON.stringify(model.verification)).not.toContain(fingerprint)
      vi.stubEnv('AZURE_OPENAI_IMAGE_ENDPOINT', 'https://another-resource.example.com')
      expect(memeProviders()[1]!.models.find(item => item.id === model.id)!.verification.t2i.status).toBe('untested')
    } finally { if (previous) memeModelChecks[key] = previous; else delete memeModelChecks[key] }
  })

  it('allows only registered models from the chosen provider and rejects unsupported modes before spending', async () => {
    const call = vi.fn<typeof fetch>()
    for (const input of [
      { provider: 'dashscope', model: 'gpt-image-2.5-sunburst' },
      { provider: 'azure', model: 'arbitrary-deployment' },
      { provider: 'azure', model: 123 },
      { provider: 'dashscope', model: 'z-image-turbo', referenceImage: IMAGE },
      { provider: 'azure', model: 'FLUX-1.1-pro', referenceImage: IMAGE },
      { provider: 'azure', model: 'MAI-Image-2e', referenceImage: IMAGE },
    ]) {
      await expect(generateMeme({ ...input, prompt: '猫' }, call)).rejects.toMatchObject({ status: 400 })
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('routes every registered model and supported mode explicitly, without changing environment defaults', async () => {
    for (const definition of MEME_MODELS) {
      for (const mode of definition.modes) {
        const call = vi.fn<typeof fetch>().mockResolvedValue(definition.provider === 'azure' ? json({ data: [{ b64_json: PNG }] }) : dashResult())
        const result = await generateMeme({ provider: definition.provider, model: definition.id, prompt: '开心的猫', ...(mode === 'it2i' ? { referenceImage: IMAGE } : {}) }, call)
        expect(result.model).toBe(definition.id)
        expect(call).toHaveBeenCalledTimes(1)
        const [url, init] = call.mock.calls[0]!
        if (definition.adapter === 'flux-kontext') {
          const body = JSON.parse(init?.body as string)
          expect(body.quality).toBeUndefined()
          expect(body.image).toBe(mode === 'it2i' ? PNG : undefined)
          expect(String(url)).toContain(mode === 'it2i' ? '/images/edits?' : '/images/generations?')
        }
        if (definition.adapter === 'flux2' || definition.adapter === 'flux11') {
          expect(String(url)).toContain(`/providers/blackforestlabs/v1/${definition.adapter === 'flux11' ? 'flux-pro-1.1' : 'flux-2-pro'}?api-version=preview`)
          const body = JSON.parse(init?.body as string)
          expect(body).toMatchObject({ model: definition.id, width: 1024, height: 1024, num_images: 1, output_format: 'jpeg' })
          expect(body.input_image).toBe(mode === 'it2i' ? PNG : undefined)
          expect(body.prompt).toContain('User request: 开心的猫')
          expect(body.n).toBeUndefined()
        }
        if (definition.adapter === 'mai') {
          expect(String(url)).toContain('/mai/v1/images/generations?api-version=preview')
          expect(init?.headers).toMatchObject({ 'api-key': 'test-azure-secret' })
        }
        if (definition.id === 'z-image-turbo') expect(JSON.parse(init?.body as string).parameters).toEqual({ size: '1024*1024', n: 1 })
      }
    }
    expect(process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT).toBe('my-gpt-image')
    expect(process.env.DASHSCOPE_IMAGE_MODEL).toBe('qwen-image-max')
    const providers = memeProviders()
    expect(providers.flatMap(item => item.models)).toHaveLength(13)
    expect(providers[0]!.defaultModel).toBe('qwen-image-3.0')
  })

  it('defaults to Qwen 3.0 non-Pro and Azure 2.5 for generation and reference editing', async () => {
    vi.stubEnv('DASHSCOPE_IMAGE_MODEL', '')
    vi.stubEnv('DASHSCOPE_IMAGE_EDIT_MODEL', '')
    vi.stubEnv('AZURE_OPENAI_IMAGE_DEPLOYMENT', '')
    expect(memeProviders()).toMatchObject([
      { id: 'dashscope', model: 'qwen-image-3.0', editModel: 'qwen-image-3.0' },
      { id: 'azure', model: 'gpt-image-2.5-sunburst', editModel: 'gpt-image-2.5-sunburst' },
    ])
    for (const provider of ['dashscope', 'azure'] as const) {
      for (const referenceImage of [undefined, IMAGE]) {
        const call = vi.fn<typeof fetch>().mockResolvedValue(provider === 'azure' ? json({ data: [{ b64_json: PNG }] }) : dashResult())
        const result = await generateMeme({ provider, prompt: '开心的猫', ...(referenceImage ? { referenceImage } : {}) }, call)
        expect(result.model).toBe(provider === 'azure' ? 'gpt-image-2.5-sunburst' : 'qwen-image-3.0')
        if (provider === 'azure') {
          expect(String(call.mock.calls[0]![0])).toContain('/deployments/gpt-image-2.5-sunburst/images/')
        } else {
          expect(JSON.parse(call.mock.calls[0]![1]?.body as string).model).toBe('qwen-image-3.0')
        }
        expect(call).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('quotes Qwen Singapore generation and editing separately, never unknown rates', () => {
    vi.stubEnv('DASHSCOPE_IMAGE_MODEL', 'qwen-image-3.0')
    vi.stubEnv('DASHSCOPE_IMAGE_EDIT_MODEL', 'qwen-image-3.0')
    vi.stubEnv('DASHSCOPE_IMAGE_ENDPOINT', 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    const [dash, azure] = memeProviders()
    expect(dash!.pricing.generation).toMatchObject({ verified: true, summary: expect.stringContaining('US$0.030'), checkedAt: '2026-10-19' })
    expect(dash!.pricing.editing).toMatchObject({ verified: true, summary: expect.stringContaining('US$0.033') })
    expect(azure!.pricing.generation).toMatchObject({ verified: false, summary: expect.stringContaining('单价未核实') })
    vi.stubEnv('DASHSCOPE_IMAGE_EDIT_MODEL', 'custom-model')
    expect(memeProviders()[0]!.pricing.editing.verified).toBe(false)
    vi.stubEnv('DASHSCOPE_IMAGE_ENDPOINT', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(memeProviders()[0]!.pricing.generation).toMatchObject({ verified: false, summary: expect.not.stringContaining('US$') })
  })

  it('lists only public configuration and disables missing/unsafe endpoints', () => {
    expect(JSON.stringify(memeProviders())).not.toMatch(/secret|endpoint|api.key/i)
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    vi.stubEnv('AZURE_OPENAI_IMAGE_ENDPOINT', 'http://azure.example.com')
    expect(memeProviders().every(item => !item.configured)).toBe(true)
  })

  it('uses DashScope multimodal messages without reference image', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(dashResult())
    const result = await generateMeme({ provider: 'dashscope', prompt: '开心的猫', style: '手绘' }, call)
    expect(result).toEqual({ image: REMOTE_IMAGE, provider: 'dashscope', model: 'qwen-image-max' })
    const [endpoint, init] = call.mock.calls[0]!
    expect(endpoint).toBe('https://dashscope.example.com/generate')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-dash-secret' })
    const payload = JSON.parse(init?.body as string)
    expect(payload.model).toBe('qwen-image-max')
    expect(payload.input.messages[0].content).toEqual([{ text: expect.stringContaining('开心的猫') }])
    expect(payload.input.messages[0].content[0].text).toContain('手绘')
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('switches DashScope model when a reference image is supplied', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(dashResult())
    await generateMeme({ provider: 'dashscope', prompt: '更开心', referenceImage: IMAGE }, call)
    const payload = JSON.parse(call.mock.calls[0]![1]?.body as string)
    expect(payload.model).toBe('qwen-image-edit')
    expect(payload.input.messages[0].content[0]).toEqual({ image: IMAGE })
  })

  it('uses Azure deployment generation URL, bearer auth and single image', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ b64_json: PNG }] }))
    const result = await generateMeme({ provider: 'azure', prompt: '开心' }, call)
    expect(result).toEqual({ image: IMAGE, provider: 'azure', model: 'my-gpt-image' })
    const [url, init] = call.mock.calls[0]!
    expect(url).toBe('https://azure.example.com/openai/deployments/my-gpt-image/images/generations?api-version=2025-04-01-preview')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-azure-secret' })
    expect(JSON.parse(init?.body as string)).toMatchObject({ size: '1024x1024', quality: 'medium', n: 1 })
  })

  it('uses Azure multipart edit with the real image MIME and api-key auth', async () => {
    vi.stubEnv('AZURE_OPENAI_IMAGE_AUTH', 'api-key')
    const call = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ b64_json: PNG }] }))
    await generateMeme({ provider: 'azure', prompt: '开心', referenceImage: IMAGE }, call)
    const [url, init] = call.mock.calls[0]!
    expect(String(url)).toContain('/images/edits?api-version=')
    expect(init?.headers).toEqual({ 'api-key': 'test-azure-secret' })
    expect(init?.body).toBeInstanceOf(FormData)
    const form = init?.body as FormData
    const image = form.get('image') as File
    expect(image.name).toBe('reference.png')
    expect(image.type).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer()).toString('base64')).toBe(PNG)
    expect(form.get('n')).toBe('1')
  })

  it.each([
    null,
    { provider: 'other', prompt: '猫' },
    { provider: 'azure', prompt: ' ' },
    { provider: 'azure', prompt: '字'.repeat(2001) },
    { provider: 'azure', prompt: '猫', style: 123 },
    { provider: 'azure', prompt: '猫', referenceImage: 'https://arbitrary.example.com/a.png' },
    { provider: 'azure', prompt: '猫', referenceImage: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { provider: 'azure', prompt: '猫', referenceImage: `data:image/jpeg;base64,${PNG}` },
    { provider: 'azure', prompt: '猫', referenceImage: 'data:image/png;base64,not-base64!' },
  ])('rejects invalid input before spending: %j', async input => {
    const call = vi.fn<typeof fetch>()
    await expect(generateMeme(input, call)).rejects.toMatchObject({ status: 400 })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects oversize reference images and missing credentials before calling', async () => {
    const call = vi.fn<typeof fetch>()
    const large = `data:image/png;base64,${Buffer.alloc(MEME_MAX_REFERENCE_BYTES + 1).toString('base64')}`
    await expect(generateMeme({ provider: 'azure', prompt: '猫', referenceImage: large }, call)).rejects.toMatchObject({ status: 400 })
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    await expect(generateMeme({ provider: 'dashscope', prompt: '猫' }, call)).rejects.toMatchObject({ status: 503 })
    expect(call).not.toHaveBeenCalled()
  })

  it('does not leak provider error bodies or retry failed paid requests', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'test-dash-secret sensitive prompt' }, 401))
    await expect(generateMeme({ provider: 'dashscope', prompt: '猫' }, call)).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('secret') })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([null, {}, { output: { choices: [] } }, { output: { choices: [{ message: { content: [{ image: 'javascript:alert(1)' }] } }] } }])('rejects malformed or unsafe provider output', async output => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(json(output))
    await expect(generateMeme({ provider: 'dashscope', prompt: '猫' }, call)).rejects.toMatchObject({ status: 502 })
  })

  it('accepts Azure image URLs but rejects corrupt image bytes', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ url: REMOTE_IMAGE }] }))
    expect((await generateMeme({ provider: 'azure', prompt: '猫' }, call)).image).toBe(REMOTE_IMAGE)
    call.mockResolvedValue(json({ data: [{ b64_json: 'aGVsbG8=' }] }))
    await expect(generateMeme({ provider: 'azure', prompt: '猫' }, call)).rejects.toMatchObject({ status: 502 })
  })

  it('reports malformed JSON and network/timeout errors without raw details', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(new Response('not json'))
    await expect(generateMeme({ provider: 'azure', prompt: '猫' }, call)).rejects.toMatchObject({ status: 502 })
    call.mockRejectedValue(new Error('secret endpoint'))
    await expect(generateMeme({ provider: 'azure', prompt: '猫' }, call)).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('secret') })
    call.mockRejectedValue(new DOMException('timeout', 'TimeoutError'))
    await expect(generateMeme({ provider: 'azure', prompt: '猫' }, call)).rejects.toMatchObject({ status: 504 })
  })
})

describe('protected meme routes', () => {
  let server: Server
  let base: string
  const headers = { 'content-type': 'application/json', 'x-test-auth': 'yes' }
  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    const auth = {
      isOriginAllowed: (req: express.Request) => req.get('origin') !== 'https://evil.example.com',
      getIdentity: (req: express.Request) => req.get('x-test-auth') === 'yes' ? { role: 'owner' } : null,
    } as unknown as LiveSessionBrowserAuth
    registerMemeRoutes({ app, auth })
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })

  it('requires browser auth for both metadata and paid generation', async () => {
    expect((await nativeFetch(`${base}/api/memes/providers`)).status).toBe(401)
    expect((await nativeFetch(`${base}/api/memes/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await nativeFetch(`${base}/api/memes/providers`, { headers: { ...headers, origin: 'https://evil.example.com' } })).status).toBe(403)
    const response = await nativeFetch(`${base}/api/memes/providers`, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('secret')
  })

  it('returns validation errors and releases the lock after failure', async () => {
    const bad = await nativeFetch(`${base}/api/memes/generate`, { method: 'POST', headers, body: '{}' })
    expect(bad.status).toBe(400)
    const call = vi.fn<typeof fetch>().mockResolvedValue(dashResult())
    vi.stubGlobal('fetch', call)
    const good = await nativeFetch(`${base}/api/memes/generate`, { method: 'POST', headers, body: JSON.stringify({ provider: 'dashscope', prompt: '猫' }) })
    expect(good.status).toBe(200)
    expect(await good.json()).toMatchObject({ image: REMOTE_IMAGE })
  })

  it('rejects concurrent paid requests without calling the provider twice', async () => {
    let finish!: (value: Response) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const call = vi.fn<typeof fetch>().mockImplementation(() => { started(); return new Promise<Response>(resolve => { finish = resolve }) })
    vi.stubGlobal('fetch', call)
    const request = () => nativeFetch(`${base}/api/memes/generate`, { method: 'POST', headers, body: JSON.stringify({ provider: 'dashscope', prompt: '猫' }) })
    const first = request()
    await ready
    try {
      const second = await request()
      expect(second.status).toBe(429)
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      finish(dashResult())
      expect((await first).status).toBe(200)
    }
  })
})
