import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { generateMeme, MEME_MAX_REFERENCE_BYTES, memeProviders } from '../memes.js'
import { registerMemeRoutes } from '../routes/memes.js'
import { MEME_MODELS, resourceFingerprint } from '../meme-models.js'
import { memeModelChecks } from '../meme-model-checks.js'
import { getMemeJob, listMemeJobs, resetMemeJobCache } from '../meme-jobs.js'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('persistent meme jobs', () => {
  let server: Server
  let base: string
  let outputDir: string
  const headers = { 'content-type': 'application/json', 'x-test-auth': 'yes' }
  const PNG_BYTES = Buffer.from(PNG, 'base64')

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
  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'pi-memes-'))
    vi.stubEnv('MEME_OUTPUT_DIR', outputDir)
    resetMemeJobCache()
  })
  afterEach(() => { resetMemeJobCache(); rmSync(outputDir, { recursive: true, force: true }) })

  function pngResponse() {
    return new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { 'content-type': 'image/png' } })
  }
  function dashImageResult(url = 'https://dashscope.example.com/result.png?signature=test') {
    return json({ output: { choices: [{ message: { content: [{ image: url }] } }] } })
  }
  function generateRequest(body: Record<string, unknown>, requestHeaders: Record<string, string> = headers) {
    return nativeFetch(`${base}/api/memes/generate`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
  }
  async function waitForJob(id: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = getMemeJob(id)
      if (job && job.status !== 'running') return job
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`job ${id} never finished`)
  }

  it('requires browser auth for metadata, history, images and paid generation', async () => {
    expect((await nativeFetch(`${base}/api/memes/providers`)).status).toBe(401)
    expect((await nativeFetch(`${base}/api/memes/jobs`)).status).toBe(401)
    expect((await nativeFetch(`${base}/api/memes/images/m1abc-abcd1234`)).status).toBe(401)
    expect((await generateRequest({ provider: 'dashscope', prompt: '猫' }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await nativeFetch(`${base}/api/memes/providers`, { headers: { ...headers, origin: 'https://evil.example.com' } })).status).toBe(403)
    const response = await nativeFetch(`${base}/api/memes/providers`, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('secret')
    const history = await nativeFetch(`${base}/api/memes/jobs`, { headers })
    expect(history.status).toBe(200)
    expect(await history.json()).toEqual({ jobs: [], outputDir })
  })

  it('rejects invalid input before creating or charging a job', async () => {
    const call = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', call)
    const bad = await generateRequest({ provider: 'dashscope' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBeTruthy()
    expect(listMemeJobs().jobs).toHaveLength(0)
    expect(call).not.toHaveBeenCalled()
    expect(readdirSync(outputDir)).toEqual([])
  })

  it('accepts the job immediately, keeps generating, and serves the stored file', async () => {
    let release!: (value: Response) => void
    const call = vi.fn<typeof fetch>(input => {
      const url = String(input)
      if (url.includes('dashscope.example.com/generate')) return new Promise<Response>(resolve => { release = resolve })
      if (url.startsWith('https://dashscope.example.com/result')) return Promise.resolve(pngResponse())
      return Promise.resolve(json({}, 404))
    })
    vi.stubGlobal('fetch', call)

    const response = await generateRequest({ provider: 'dashscope', prompt: '困困的猫' })
    expect(response.status).toBe(202)
    const { job } = await response.json() as { job: { id: string; status: string } }
    expect(job.status).toBe('running')
    expect(job.id).toMatch(/^m[a-z0-9]+-[a-f0-9]{8}$/)
    expect(await (await nativeFetch(`${base}/api/memes/jobs`, { headers })).json()).toMatchObject({
      jobs: [{ id: job.id, status: 'running' }],
    })

    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    release(dashImageResult())
    const finished = await waitForJob(job.id)
    expect(finished).toMatchObject({ status: 'done', provider: 'dashscope', model: 'qwen-image-max', mime: 'image/png' })
    expect(finished.file).toBe(`${job.id}.png`)
    expect(finished.remoteUrl).toBeUndefined()
    expect(readdirSync(outputDir).sort()).toEqual(['jobs.json', `${job.id}.png`])

    const history = await (await nativeFetch(`${base}/api/memes/jobs`, { headers })).json() as { jobs: { imageUrl: string }[] }
    expect(history.jobs[0]!.imageUrl).toBe(`/api/memes/images/${job.id}`)

    const image = await nativeFetch(`${base}/api/memes/images/${job.id}`, { headers })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('cache-control')).toContain('immutable')
    expect(image.headers.get('content-disposition')).toBe(`inline; filename="meme-${job.id}.png"`)
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    const download = await nativeFetch(`${base}/api/memes/images/${job.id}?download=1`, { headers })
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="meme-${job.id}.png"`)

    // The record survives a restart: the next process reads it back from disk.
    resetMemeJobCache()
    expect(getMemeJob(job.id)).toMatchObject({ status: 'done', file: `${job.id}.png` })
  })

  it('rejects a second paid request while one is running', async () => {
    let release!: (value: Response) => void
    const call = vi.fn<typeof fetch>(input => {
      if (String(input).includes('dashscope.example.com/generate')) return new Promise<Response>(resolve => { release = resolve })
      return Promise.resolve(pngResponse())
    })
    vi.stubGlobal('fetch', call)

    const first = await generateRequest({ provider: 'dashscope', prompt: '困困的猫' })
    expect(first.status).toBe(202)
    const firstJob = (await first.json() as { job: { id: string } }).job
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    const second = await generateRequest({ provider: 'dashscope', prompt: '开心的狗' })
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({ job: { id: firstJob.id, status: 'running' } })
    expect(call).toHaveBeenCalledTimes(1)
    expect(listMemeJobs().jobs).toHaveLength(1)

    release(dashImageResult())
    expect((await waitForJob(firstJob.id)).status).toBe('done')
  })

  it('saves provider links from its own domain and keeps links from elsewhere unconverted', async () => {
    const call = vi.fn<typeof fetch>(input => {
      if (String(input).includes('dashscope.example.com/generate')) return Promise.resolve(dashImageResult())
      return Promise.resolve(pngResponse())
    })
    vi.stubGlobal('fetch', call)
    const saved = (await (await generateRequest({ provider: 'dashscope', prompt: '猫' })).json() as { job: { id: string } }).job
    const savedJob = await waitForJob(saved.id)
    expect(savedJob).toMatchObject({ status: 'done', file: `${saved.id}.png` })
    expect(call).toHaveBeenCalledTimes(2)

    const foreign = vi.fn<typeof fetch>().mockResolvedValue(dashImageResult('https://cdn.example.net/cat.png'))
    vi.stubGlobal('fetch', foreign)
    const linked = (await (await generateRequest({ provider: 'dashscope', prompt: '狗' })).json() as { job: { id: string } }).job
    const linkedJob = await waitForJob(linked.id)
    expect(linkedJob).toMatchObject({ status: 'done', remoteUrl: 'https://cdn.example.net/cat.png' })
    expect(linkedJob.file).toBeUndefined()
    expect(linkedJob.note).toContain('临时链接')
    expect(foreign).toHaveBeenCalledTimes(1)
    expect(readdirSync(outputDir).filter(name => name.startsWith(linked.id))).toEqual([])
  })

  it('marks jobs left running by a dead process as failed on the next start', async () => {
    const stale = {
      id: 'm1abc-abcd1234', status: 'running', provider: 'dashscope', model: 'qwen-image-3.0',
      mode: 't2i', prompt: '猫', style: '', createdAt: Date.now(),
    }
    writeFileSync(join(outputDir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [stale] }), 'utf8')
    resetMemeJobCache()
    const { jobs } = listMemeJobs()
    expect(jobs[0]).toMatchObject({ id: stale.id, status: 'failed' })
    expect(jobs[0]!.error).toContain('服务进程')
    expect(getMemeJob(stale.id)).toMatchObject({ status: 'failed' })
  })

  it('refuses unknown and traversal image ids', async () => {
    expect((await nativeFetch(`${base}/api/memes/images/not-an-id`, { headers })).status).toBe(404)
    expect((await nativeFetch(`${base}/api/memes/images/${encodeURIComponent('../jobs.json')}`, { headers })).status).toBe(404)
    expect((await nativeFetch(`${base}/api/memes/jobs/not-an-id`, { headers })).status).toBe(404)
  })
})