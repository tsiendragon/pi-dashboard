/**
 * DashScope Qwen-TTS adapter (non-realtime HTTP synthesis).
 *
 * The API returns a 24h-signed OSS URL (or inline base64). The dashboard
 * downloads the audio server-side and hands the browser raw bytes, which keeps
 * playback same-origin (no mixed-content / expiring-URL failures) and keeps the
 * `DASHSCOPE_API_KEY` out of the browser.
 */
import { TTS_DEFAULT_MODEL, TTS_DEFAULT_VOICE, TTS_MAX_TEXT_CHARS, type TtsRequest } from '../shared/src/tts.js'
import {
  DASHSCOPE_MULTIMODAL_PATH,
  DASHSCOPE_REQUEST_TIMEOUT_MS,
  dashscopeApiKey,
  resolveDashscopeBaseUrl,
} from './dashscope.js'

export class TtsError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message)
    this.name = 'TtsError'
  }
}

interface PreparedText {
  text: string
  truncated: boolean
}

/** DashScope rejects oversized input; cut on a sentence boundary when possible. */
export function clampTtsText(raw: string, maxChars = TTS_MAX_TEXT_CHARS): PreparedText {
  const text = raw.trim()
  if (text.length <= maxChars) return { text, truncated: false }
  const slice = text.slice(0, maxChars)
  const boundary = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('.'), slice.lastIndexOf('！'), slice.lastIndexOf('!'), slice.lastIndexOf('\n'))
  const cut = boundary > maxChars * 0.6 ? boundary + 1 : slice.length
  return { text: slice.slice(0, cut), truncated: true }
}

export interface TtsAudio {
  bytes: Buffer
  contentType: string
  model: string
  voice: string
  truncated: boolean
}

interface ProviderAudio {
  url?: unknown
  data?: unknown
}

function providerAudio(payload: unknown): ProviderAudio | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const output = (payload as Record<string, unknown>).output
  if (!output || typeof output !== 'object') return undefined
  const audio = (output as Record<string, unknown>).audio
  if (!audio || typeof audio !== 'object') return undefined
  return audio as ProviderAudio
}

function providerErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const code = typeof record.code === 'string' ? record.code : undefined
    const message = typeof record.message === 'string' ? record.message : undefined
    if (code || message) return [code, message].filter(Boolean).join(': ')
  }
  return `DashScope TTS request failed with HTTP ${status}`
}

export function ttsAvailability(): { available: boolean; reason?: string } {
  return dashscopeApiKey()
    ? { available: true }
    : { available: false, reason: '后端进程未配置 DASHSCOPE_API_KEY，语音输出不可用。' }
}

export async function synthesizeSpeech(
  request: TtsRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TtsAudio> {
  const apiKey = dashscopeApiKey()
  if (!apiKey) {
    throw new TtsError('tts_api_key_missing', '未找到 DASHSCOPE_API_KEY：请在后端进程环境中配置后重启服务。', 503)
  }

  const model = request.model?.trim() || TTS_DEFAULT_MODEL
  const voice = request.voice?.trim() || TTS_DEFAULT_VOICE
  const { text, truncated } = clampTtsText(request.text ?? '')
  if (!text) throw new TtsError('tts_text_required', 'text 不能为空。', 400)

  const input: Record<string, unknown> = { text, voice }
  if (request.languageType?.trim()) input.language_type = request.languageType.trim()
  const body: Record<string, unknown> = { model, input }
  if (request.instructions?.trim()) {
    body.parameters = { instructions: request.instructions.trim(), optimize_instructions: true }
  }

  const response = await fetchImpl(`${resolveDashscopeBaseUrl()}${DASHSCOPE_MULTIMODAL_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DASHSCOPE_REQUEST_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new TtsError('tts_provider_error', providerErrorMessage(payload, response.status), 502)
  }

  const audio = providerAudio(payload)
  if (!audio) throw new TtsError('tts_provider_error', providerErrorMessage(payload, response.status), 502)

  if (typeof audio.data === 'string' && audio.data) {
    return { bytes: Buffer.from(audio.data, 'base64'), contentType: 'audio/wav', model, voice, truncated }
  }

  if (typeof audio.url !== 'string' || !audio.url) {
    throw new TtsError('tts_empty_audio', 'DashScope 未返回音频数据。', 502)
  }

  const download = await fetchImpl(audio.url, { signal: AbortSignal.timeout(DASHSCOPE_REQUEST_TIMEOUT_MS) })
  if (!download.ok) {
    throw new TtsError('tts_download_failed', `音频下载失败（HTTP ${download.status}）。`, 502)
  }
  const bytes = Buffer.from(await download.arrayBuffer())
  if (bytes.length === 0) throw new TtsError('tts_empty_audio', 'DashScope 返回空音频。', 502)

  return {
    bytes,
    contentType: download.headers.get('content-type') || 'audio/wav',
    model,
    voice,
    truncated,
  }
}