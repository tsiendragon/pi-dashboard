/**
 * Tests for the DashScope Qwen-TTS adapter and its HTTP routes.
 *
 * The provider is never called for real: `fetch` is injected/stubbed so the
 * request shape, the URL→bytes download, inline base64 audio, and error mapping
 * are asserted without a network or an API key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TtsError, clampTtsText, synthesizeSpeech } from '../tts.js'
import { resolveDashscopeBaseUrl } from '../dashscope.js'
import { registerVoiceRoutes } from '../routes/voice.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  delete process.env.DASHSCOPE_TTS_BASE_URL
  delete process.env.DASHSCOPE_BASE_URL
  process.env.DASHSCOPE_API_KEY = 'test-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
})

describe('clampTtsText', () => {
  it('keeps short text untouched', () => {
    expect(clampTtsText('你好，世界。')).toEqual({ text: '你好，世界。', truncated: false })
  })

  it('cuts long text on a sentence boundary and flags truncation', () => {
    const long = `${'这是一段很长的回复。'.repeat(300)}`
    const result = clampTtsText(long, 100)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(100)
    expect(result.text.endsWith('。')).toBe(true)
  })

  it('reports empty input as empty', () => {
    expect(clampTtsText('   ')).toEqual({ text: '', truncated: false })
  })
})

describe('resolveDashscopeBaseUrl', () => {
  it('honours DASHSCOPE_TTS_BASE_URL and strips the OpenAI-compatible suffix', () => {
    process.env.DASHSCOPE_TTS_BASE_URL = 'https://tts.example.com/compatible-mode/v1/'
    expect(resolveDashscopeBaseUrl()).toBe('https://tts.example.com')
  })

  it('falls back to DASHSCOPE_BASE_URL', () => {
    process.env.DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com'
    expect(resolveDashscopeBaseUrl()).toBe('https://dashscope-intl.aliyuncs.com')
  })
})

describe('synthesizeSpeech', () => {
  it('posts the vendor payload and downloads the signed audio URL', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/generation')) {
        return new Response(JSON.stringify({ output: { audio: { url: 'http://oss.local/a.wav', data: '' } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': 'audio/x-wav' } })
    }) as unknown as typeof fetch

    const audio = await synthesizeSpeech({ text: '你好', voice: 'Cherry' }, fetchImpl)

    const [firstUrl, firstInit] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(firstUrl).toContain('/api/v1/services/aigc/multimodal-generation/generation')
    expect((firstInit.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(JSON.parse(String(firstInit.body))).toEqual({ model: 'qwen3-tts-flash', input: { text: '你好', voice: 'Cherry' } })
    expect(audio.bytes.length).toBe(4)
    expect(audio.contentType).toBe('audio/x-wav')
    expect(audio.truncated).toBe(false)
  })

  it('sends language_type and instruct parameters only when provided', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/generation')) {
        return new Response(JSON.stringify({ output: { audio: { data: Buffer.from([9, 9]).toString('base64') } } }), { status: 200 })
      }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as unknown as typeof fetch

    const audio = await synthesizeSpeech({
      text: 'hi',
      model: 'qwen3-tts-instruct-flash',
      languageType: 'English',
      instructions: '语气亲切',
    }, fetchImpl)

    const body = JSON.parse(String((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body))
    expect(body.input.language_type).toBe('English')
    expect(body.parameters).toEqual({ instructions: '语气亲切', optimize_instructions: true })
    expect(audio.bytes).toEqual(Buffer.from([9, 9]))
  })

  it('fails with tts_api_key_missing when no key is configured', async () => {
    delete process.env.DASHSCOPE_API_KEY
    await expect(synthesizeSpeech({ text: 'hi' })).rejects.toMatchObject({ code: 'tts_api_key_missing', status: 503 })
  })

  it('maps provider errors to tts_provider_error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 'InvalidParameter', message: 'Invalid voice specified.' }), { status: 400 })) as unknown as typeof fetch
    await expect(synthesizeSpeech({ text: 'hi' }, fetchImpl)).rejects.toMatchObject({
      code: 'tts_provider_error',
      message: 'InvalidParameter: Invalid voice specified.',
    })
  })

  it('rejects an empty text request before calling the provider', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(synthesizeSpeech({ text: '   ' }, fetchImpl)).rejects.toMatchObject({ code: 'tts_text_required', status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

interface FakeRoute {
  GET?: (req: unknown, res: unknown) => unknown
  POST?: (req: unknown, res: unknown) => unknown
}

function fakeApp(): Record<string, FakeRoute> & { get: unknown; post: unknown } {
  const routes: Record<string, FakeRoute> = {}
  return {
    routes,
    get(path: string, handler: (req: unknown, res: unknown) => unknown) { (routes[path] ||= {}).GET = handler },
    post(path: string, handler: (req: unknown, res: unknown) => unknown) { (routes[path] ||= {}).POST = handler },
  } as unknown as Record<string, FakeRoute> & { get: unknown; post: unknown }
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    jsonBody: undefined as unknown,
    sentBody: undefined as unknown,
    status(code: number) { res.statusCode = code; return res },
    json(payload: unknown) { res.jsonBody = payload; return res },
    setHeader(key: string, value: string) { res.headers[key] = value; return res },
    send(body: unknown) { res.sentBody = body; return res },
  }
  return res
}

describe('voice routes', () => {
  it('GET /api/tts/config reports availability, endpoint and catalog', () => {
    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    ;(app.routes['/api/tts/config'] as FakeRoute).GET!({}, res)

    const body = res.jsonBody as Record<string, unknown>
    expect(body.available).toBe(true)
    expect(body.defaultModel).toBe('qwen3-tts-flash')
    expect((body.voices as { id: string }[]).some(v => v.id === 'Cherry')).toBe(true)
    expect(String(body.endpoint)).toMatch(/^https:\/\//)
  })

  it('GET /api/tts/config explains a missing key', () => {
    delete process.env.DASHSCOPE_API_KEY
    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    ;(app.routes['/api/tts/config'] as FakeRoute).GET!({}, res)

    expect((res.jsonBody as { available: boolean }).available).toBe(false)
    expect(String((res.jsonBody as { reason: string }).reason)).toContain('DASHSCOPE_API_KEY')
  })

  it('POST /api/tts/speak streams audio bytes with model headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/generation')
      ? new Response(JSON.stringify({ output: { audio: { data: Buffer.from('abc').toString('base64') } } }), { status: 200 })
      : new Response(new Uint8Array([0]), { status: 200 }))))

    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    await (app.routes['/api/tts/speak'] as FakeRoute).POST!({ body: { text: '你好', voice: 'Ethan' } }, res)

    expect(res.headers['Content-Type']).toBe('audio/wav')
    expect(res.headers['X-Tts-Voice']).toBe('Ethan')
    expect(res.sentBody).toEqual(Buffer.from('abc'))
  })

  it('POST /api/tts/speak returns the mapped error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'InvalidParameter', message: 'nope' }), { status: 400 })))

    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    await (app.routes['/api/tts/speak'] as FakeRoute).POST!({ body: { text: '你好' } }, res)

    expect(res.statusCode).toBe(502)
    expect(res.jsonBody).toMatchObject({ error: 'tts_provider_error' })
  })
})

describe('TtsError', () => {
  it('defaults to a 502 status', () => {
    expect(new TtsError('x', 'y').status).toBe(502)
  })
})