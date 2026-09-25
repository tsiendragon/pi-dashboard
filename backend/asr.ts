/**
 * DashScope Qwen-ASR adapter (non-realtime speech-to-text).
 *
 * The browser records a clip and posts it base64-inline; the backend transcribes
 * it here. This deliberately does not use the browser's built-in
 * `SpeechRecognition`: that uploads audio to Google, is Chromium-only, and fails
 * with `network` on restricted networks.
 */
import { ASR_DEFAULT_MODEL, type AsrRequest, type AsrResult } from '../shared/src/asr.js'
import {
  DASHSCOPE_MULTIMODAL_PATH,
  DASHSCOPE_REQUEST_TIMEOUT_MS,
  dashscopeApiKey,
  resolveDashscopeBaseUrl,
} from './dashscope.js'

export class AsrError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message)
    this.name = 'AsrError'
  }
}

export function asrAvailability(): { available: boolean; reason?: string } {
  return dashscopeApiKey()
    ? { available: true }
    : { available: false, reason: '后端进程未配置 DASHSCOPE_API_KEY，语音输入不可用。' }
}

function providerMessage(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const choices = (payload as Record<string, unknown>).output
  if (!choices || typeof choices !== 'object') return undefined
  const list = (choices as Record<string, unknown>).choices
  if (!Array.isArray(list) || !list[0] || typeof list[0] !== 'object') return undefined
  const message = (list[0] as Record<string, unknown>).message
  return message && typeof message === 'object' ? message as Record<string, unknown> : undefined
}

/** Concatenated transcript from the response's content parts. */
export function providerTranscript(payload: unknown): string | undefined {
  const message = providerMessage(payload)
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(part => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
      ? (part as Record<string, unknown>).text as string
      : '')
    .join('')
    .trim()
  return text
}

function providerLanguage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const output = (payload as Record<string, unknown>).output
  if (!output || typeof output !== 'object') return undefined
  const annotations = (output as Record<string, unknown>).annotations
  if (!Array.isArray(annotations)) return undefined
  for (const annotation of annotations) {
    if (annotation && typeof annotation === 'object' && typeof (annotation as Record<string, unknown>).language === 'string') {
      return (annotation as Record<string, unknown>).language as string
    }
  }
  return undefined
}

function providerSeconds(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const usage = (payload as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return undefined
  const seconds = (usage as Record<string, unknown>).seconds
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : undefined
}

function providerErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const code = typeof record.code === 'string' ? record.code : undefined
    const message = typeof record.message === 'string' ? record.message : undefined
    if (code || message) return [code, message].filter(Boolean).join(': ')
  }
  return `DashScope ASR request failed with HTTP ${status}`
}

export async function transcribeAudio(
  request: AsrRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AsrResult> {
  const apiKey = dashscopeApiKey()
  if (!apiKey) {
    throw new AsrError('asr_api_key_missing', '未找到 DASHSCOPE_API_KEY：请在后端进程环境中配置后重启服务。', 503)
  }

  const audio = request.audioBase64?.trim()
  if (!audio) throw new AsrError('asr_audio_required', 'audioBase64 不能为空。', 400)

  const model = request.model?.trim() || ASR_DEFAULT_MODEL
  const mimeType = request.mimeType?.trim() || 'audio/webm'
  const body: Record<string, unknown> = {
    model,
    input: { messages: [{ role: 'user', content: [{ audio: `data:${mimeType};base64,${audio}` }] }] },
  }
  // An unrecognised language code is a hard provider error, so only send known ones.
  if (request.language?.trim()) {
    body.parameters = { asr_options: { language: request.language.trim() } }
  }

  const response = await fetchImpl(`${resolveDashscopeBaseUrl()}${DASHSCOPE_MULTIMODAL_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DASHSCOPE_REQUEST_TIMEOUT_MS),
  })

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new AsrError('asr_provider_error', providerErrorMessage(payload, response.status), 502)
  }

  const text = providerTranscript(payload)
  if (text === undefined) {
    throw new AsrError('asr_empty_result', 'DashScope 未返回识别文本。', 502)
  }
  // Silence / unrecognisable audio: tell the user rather than inserting nothing.
  if (!text) {
    throw new AsrError('asr_no_speech', '没有识别到语音内容，请靠近麦克风再说一次。', 422)
  }

  return {
    text,
    ...(providerLanguage(payload) ? { language: providerLanguage(payload) } : {}),
    model,
    ...(providerSeconds(payload) !== undefined ? { seconds: providerSeconds(payload) } : {}),
  }
}