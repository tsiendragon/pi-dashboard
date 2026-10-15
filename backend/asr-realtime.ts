import { randomUUID } from 'crypto'
import WebSocket, { type RawData } from 'ws'
import { ASR_REALTIME_MODEL, normalizeAsrLanguage } from '../shared/src/asr.js'
import { dashscopeApiKey, resolveDashscopeBaseUrl } from './dashscope.js'

export const ASR_REALTIME_PATH = '/api/asr/realtime'
const AUDIO_CHUNK_BASE64_LIMIT = 48 * 1024
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 15_000

export function asrRealtimeUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('DashScope base URL must use HTTP or HTTPS')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api-ws/v1/realtime'
  url.search = ''
  url.hash = ''
  url.searchParams.set('model', ASR_REALTIME_MODEL)
  return url.toString()
}

export function asrRealtimeSessionUpdate(language?: string): Record<string, unknown> {
  const normalizedLanguage = normalizeAsrLanguage(language)
  return {
    type: 'session.update',
    event_id: randomUUID(),
    session: {
      input_audio_format: 'pcm',
      sample_rate: 16_000,
      input_audio_transcription: normalizedLanguage ? { language: normalizedLanguage } : {},
      turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 500 },
    },
  }
}

export interface AsrRealtimeBridgeOptions {
  apiKey?: string
  baseUrl?: string
  createUpstream?: (url: string, apiKey: string) => WebSocket
}

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Bridges browser audio chunks to DashScope without exposing the API key to the browser. */
export function handleAsrRealtimeConnection(
  client: WebSocket,
  language: string | null,
  options: AsrRealtimeBridgeOptions = {},
): void {
  const apiKey = options.apiKey ?? dashscopeApiKey()
  if (!apiKey) {
    client.send(JSON.stringify({ type: 'error', message: '后端未配置 DASHSCOPE_API_KEY，实时语音识别不可用。' }))
    client.close(1011, 'ASR API key missing')
    return
  }

  let upstream: WebSocket
  try {
    const url = asrRealtimeUrl(options.baseUrl ?? resolveDashscopeBaseUrl())
    upstream = options.createUpstream
      ? options.createUpstream(url, apiKey)
      : new WebSocket(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
        })
  } catch (error) {
    client.send(JSON.stringify({
      type: 'error',
      message: error instanceof Error ? error.message : '无法连接实时语音识别服务。',
    }))
    client.close(1011, 'ASR connection setup failed')
    return
  }

  let ready = false
  let finishSent = false
  let closed = false

  const sendClient = (message: unknown): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }
  const fail = (message: string): void => {
    if (closed) return
    closed = true
    sendClient({ type: 'error', message })
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'ASR upstream failed')
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1011, 'ASR upstream failed')
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  }

  upstream.on('open', () => {
    upstream.send(JSON.stringify(asrRealtimeSessionUpdate(language ?? undefined)))
  })
  upstream.on('message', (data: RawData) => {
    let message: Record<string, unknown> | undefined
    try {
      message = record(JSON.parse(rawDataText(data)))
    } catch {
      fail('实时语音服务返回了无法解析的消息。')
      return
    }
    if (!message || typeof message.type !== 'string') return

    if (message.type === 'session.updated') {
      ready = true
      sendClient({ type: 'ready' })
      return
    }
    if (message.type === 'error') {
      const details = record(message.error)
      fail(typeof details?.message === 'string' ? details.message : '实时语音识别服务返回错误。')
      return
    }
    if (message.type === 'session.finished') {
      closed = true
      sendClient({ type: 'finished' })
      if (client.readyState === WebSocket.OPEN) client.close(1000, 'ASR session finished')
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'ASR session finished')
      return
    }
    if (message.type === 'conversation.item.input_audio_transcription.text'
      || message.type === 'conversation.item.input_audio_transcription.completed'
      || message.type === 'conversation.item.input_audio_transcription.failed') {
      sendClient(message)
    }
  })
  upstream.on('unexpected-response', (_request, response) => {
    response.resume()
    fail(`实时语音服务连接失败（HTTP ${response.statusCode ?? 'unknown'}），请检查 DashScope 模型权限和地域配置。`)
  })
  upstream.on('error', () => fail('实时语音服务连接失败，请检查 DashScope 配置后重试。'))
  upstream.on('close', () => {
    if (!closed) fail('实时语音连接已中断。')
  })

  client.on('message', (data: RawData, isBinary: boolean) => {
    if (closed) return
    if (isBinary) {
      fail('实时语音连接只接受 JSON 音频消息。')
      return
    }

    let message: Record<string, unknown> | undefined
    try {
      message = record(JSON.parse(rawDataText(data)))
    } catch {
      fail('实时语音消息格式无效。')
      return
    }
    if (!message || typeof message.type !== 'string') {
      fail('实时语音消息格式无效。')
      return
    }
    if (message.type === 'audio') {
      const audio = message.audio
      if (!ready || typeof audio !== 'string' || !audio || audio.length > AUDIO_CHUNK_BASE64_LIMIT
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) {
        fail('实时音频数据无效或连接尚未就绪。')
        return
      }
      upstream.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        event_id: randomUUID(),
        audio,
      }))
      return
    }
    if (message.type === 'finish') {
      if (!ready || finishSent) return
      finishSent = true
      upstream.send(JSON.stringify({ type: 'session.finish', event_id: randomUUID() }))
      return
    }
    fail('实时语音消息类型不受支持。')
  })

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'browser disconnected')
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  })
  client.on('error', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1011, 'browser socket error')
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  })
}
