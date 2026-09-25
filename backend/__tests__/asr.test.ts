/**
 * Tests for the DashScope Qwen-ASR adapter and its HTTP route.
 *
 * The provider is never called for real: `fetch` is injected/stubbed so the
 * request shape (inline base64 data URL, optional language), transcript
 * extraction, and error mapping are asserted without a network or an API key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AsrError, transcribeAudio } from '../asr.js'
import { normalizeAsrLanguage } from '../../shared/src/asr.js'
import { registerVoiceRoutes } from '../routes/voice.js'

const ORIGINAL_ENV = { ...process.env }

function transcriptResponse(text: string, language = 'zh', seconds = 2): Response {
  return new Response(JSON.stringify({
    output: {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ text }] } }],
      annotations: [{ type: 'audio_info', language, emotion: 'neutral' }],
    },
    usage: { seconds },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  delete process.env.DASHSCOPE_TTS_BASE_URL
  delete process.env.DASHSCOPE_BASE_URL
  process.env.DASHSCOPE_API_KEY = 'test-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
})

describe('normalizeAsrLanguage', () => {
  it('keeps known short codes and maps anything unknown to auto-detect', () => {
    expect(normalizeAsrLanguage('zh')).toBe('zh')
    expect(normalizeAsrLanguage('en')).toBe('en')
    expect(normalizeAsrLanguage('')).toBe('')
    // Legacy/unverified values must not reach the provider (it 400s on them).
    expect(normalizeAsrLanguage('zh-CN')).toBe('')
    expect(normalizeAsrLanguage('nope')).toBe('')
  })
})

describe('transcribeAudio', () => {
  it('posts inline base64 audio and returns the transcript', async () => {
    const fetchImpl = vi.fn(async () => transcriptResponse('帮我看下这个报错', 'zh', 3)) as unknown as typeof fetch

    const result = await transcribeAudio({ audioBase64: 'QUJD', mimeType: 'audio/webm', language: 'zh' }, fetchImpl)

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toContain('/api/v1/services/aigc/multimodal-generation/generation')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('qwen3-asr-flash')
    expect(body.input.messages[0].content[0].audio).toBe('data:audio/webm;base64,QUJD')
    expect(body.parameters).toEqual({ asr_options: { language: 'zh' } })
    expect(result).toEqual({ text: '帮我看下这个报错', language: 'zh', model: 'qwen3-asr-flash', seconds: 3 })
  })

  it('omits the language parameter when none is set', async () => {
    const fetchImpl = vi.fn(async () => transcriptResponse('hi')) as unknown as typeof fetch
    await transcribeAudio({ audioBase64: 'QUJD' }, fetchImpl)
    const body = JSON.parse(String((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1].body))
    expect(body.parameters).toBeUndefined()
    expect(body.input.messages[0].content[0].audio).toMatch(/^data:audio\/webm;base64,/)
  })

  it('fails with asr_audio_required before calling the provider', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(transcribeAudio({ audioBase64: '  ' }, fetchImpl)).rejects.toMatchObject({ code: 'asr_audio_required', status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails with asr_api_key_missing when no key is configured', async () => {
    delete process.env.DASHSCOPE_API_KEY
    await expect(transcribeAudio({ audioBase64: 'QUJD' })).rejects.toMatchObject({ code: 'asr_api_key_missing', status: 503 })
  })

  it('maps provider errors to asr_provider_error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 'InvalidParameter', message: "Language code 'x' is not recognized." }), { status: 400 })) as unknown as typeof fetch
    await expect(transcribeAudio({ audioBase64: 'QUJD' }, fetchImpl)).rejects.toMatchObject({
      code: 'asr_provider_error',
      message: "InvalidParameter: Language code 'x' is not recognized.",
    })
  })

  it('reports silence as no speech instead of returning nothing', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ text: '   ' }] } }] } }), { status: 200 })) as unknown as typeof fetch
    await expect(transcribeAudio({ audioBase64: 'QUJD' }, fetchImpl)).rejects.toMatchObject({ code: 'asr_no_speech', status: 422 })
  })
})

interface FakeRoute {
  GET?: (req: unknown, res: unknown) => unknown
  POST?: (req: unknown, res: unknown) => unknown
}

function fakeApp() {
  const routes: Record<string, FakeRoute> = {}
  return {
    routes,
    get(path: string, handler: (req: unknown, res: unknown) => unknown) { (routes[path] ||= {}).GET = handler },
    post(path: string, handler: (req: unknown, res: unknown) => unknown) { (routes[path] ||= {}).POST = handler },
  }
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    jsonBody: undefined as unknown,
    status(code: number) { res.statusCode = code; return res },
    json(payload: unknown) { res.jsonBody = payload; return res },
    setHeader(key: string, value: string) { res.headers[key] = value; return res },
    send(body: unknown) { res.jsonBody = body; return res },
  }
  return res
}

describe('asr routes', () => {
  it('GET /api/asr/config reports availability, model and languages', () => {
    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    ;(app.routes['/api/asr/config'] as FakeRoute).GET!({}, res)

    const body = res.jsonBody as Record<string, unknown>
    expect(body.available).toBe(true)
    expect(body.defaultModel).toBe('qwen3-asr-flash')
    expect((body.languages as { id: string }[]).some(language => language.id === 'zh')).toBe(true)
  })

  it('POST /api/asr/transcribe returns the transcript and normalizes the language', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => transcriptResponse('你好世界')))
    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    await (app.routes['/api/asr/transcribe'] as FakeRoute).POST!({
      body: { audio_base64: 'QUJD', mime_type: 'audio/webm', language: 'zh-CN' },
    }, res)

    expect(res.jsonBody).toMatchObject({ text: '你好世界', model: 'qwen3-asr-flash' })
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))
    // 'zh-CN' is not a provider code: it must be dropped rather than rejected.
    expect(sent.parameters).toBeUndefined()
  })

  it('POST /api/asr/transcribe rejects oversized recordings', async () => {
    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    await (app.routes['/api/asr/transcribe'] as FakeRoute).POST!({
      body: { audio_base64: 'A'.repeat(15 * 1024 * 1024) },
    }, res)

    expect(res.statusCode).toBe(413)
    expect(res.jsonBody).toMatchObject({ error: 'asr_audio_too_large' })
  })

  it('POST /api/asr/transcribe surfaces provider errors with a sibling status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'BadRequest', message: 'nope' }), { status: 400 })))
    const app = fakeApp()
    registerVoiceRoutes({ app: app as never })
    const res = fakeRes()

    await (app.routes['/api/asr/transcribe'] as FakeRoute).POST!({ body: { audio_base64: 'QUJD' } }, res)

    expect(res.statusCode).toBe(502)
    expect(res.jsonBody).toMatchObject({ error: 'asr_provider_error' })
  })
})

describe('AsrError', () => {
  it('defaults to a 502 status', () => {
    expect(new AsrError('x', 'y').status).toBe(502)
  })
})