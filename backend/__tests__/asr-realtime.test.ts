import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { asrRealtimeSessionUpdate, asrRealtimeUrl, handleAsrRealtimeConnection } from '../asr-realtime.js'

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN
  readonly sent: string[] = []
  closeCode?: number

  send(message: string): void { this.sent.push(message) }
  close(code = 1000): void {
    this.closeCode = code
    this.readyState = WebSocket.CLOSED
    this.emit('close', code, Buffer.alloc(0))
  }
  terminate(): void { this.readyState = WebSocket.CLOSED }
}

function messages(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map(message => JSON.parse(message) as Record<string, unknown>)
}

describe('DashScope realtime ASR', () => {
  it('builds a regional WebSocket URL with the realtime model', () => {
    expect(asrRealtimeUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'))
      .toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
  })

  it('configures PCM16k VAD and normalizes the selected language', () => {
    expect(asrRealtimeSessionUpdate('zh-CN')).toMatchObject({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16_000,
        input_audio_transcription: {},
        turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 500 },
      },
    })
    expect(asrRealtimeSessionUpdate('zh').session).toMatchObject({
      input_audio_transcription: { language: 'zh' },
    })
    expect(asrRealtimeSessionUpdate('zh', 'API、session、Pi Dashboard 等技术词')).toMatchObject({
      session: { input_audio_transcription: { language: 'zh', corpus: { text: 'API、session、Pi Dashboard 等技术词' } } },
    })
  })

  it('keeps the API key server-side and bridges audio and transcript events', () => {
    const client = new FakeSocket()
    const upstream = new FakeSocket()
    const createUpstream = vi.fn((_url: string, _apiKey: string) => upstream as unknown as WebSocket)
    handleAsrRealtimeConnection(client as unknown as WebSocket, 'zh', {
      apiKey: 'test-key',
      baseUrl: 'https://dashscope.aliyuncs.com',
      createUpstream,
    })

    expect(createUpstream).toHaveBeenCalledWith(
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
      'test-key',
    )
    upstream.emit('open')
    expect(messages(upstream)[0]).toMatchObject({
      type: 'session.update',
      session: { input_audio_transcription: { language: 'zh' } },
    })

    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })), false)
    expect(messages(client)).toContainEqual({ type: 'ready' })
    client.emit('message', Buffer.from(JSON.stringify({ type: 'audio', audio: 'AA==' })), false)
    expect(messages(upstream).at(-1)).toMatchObject({ type: 'input_audio_buffer.append', audio: 'AA==' })

    const partial = { type: 'conversation.item.input_audio_transcription.text', text: 'hello', stash: ' there' }
    upstream.emit('message', Buffer.from(JSON.stringify(partial)), false)
    expect(messages(client)).toContainEqual(partial)

    client.emit('message', Buffer.from(JSON.stringify({ type: 'finish' })), false)
    expect(messages(upstream).at(-1)).toMatchObject({ type: 'session.finish' })
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'session.finished' })), false)
    expect(messages(client).at(-1)).toEqual({ type: 'finished' })
  })

  it('passes a client context frame to Qwen without putting it in the URL', () => {
    const client = new FakeSocket()
    const upstream = new FakeSocket()
    const createUpstream = vi.fn((_url: string, _apiKey: string) => upstream as unknown as WebSocket)
    handleAsrRealtimeConnection(client as unknown as WebSocket, 'zh', {
      apiKey: 'test-key',
      createUpstream,
    })
    client.emit('message', Buffer.from(JSON.stringify({ type: 'context', text: 'API session 路径' })), false)
    upstream.emit('open')
    expect(messages(upstream)[0]).toMatchObject({
      type: 'session.update',
      session: { input_audio_transcription: { language: 'zh', corpus: { text: 'API session 路径' } } },
    })
  })

  it('never sends a second session.update when context arrives after upstream opened', () => {
    const client = new FakeSocket()
    const upstream = new FakeSocket()
    const createUpstream = vi.fn((_url: string, _apiKey: string) => upstream as unknown as WebSocket)
    handleAsrRealtimeConnection(client as unknown as WebSocket, 'zh', {
      apiKey: 'test-key',
      createUpstream,
    })
    upstream.emit('open')
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })), false)
    client.emit('message', Buffer.from(JSON.stringify({ type: 'audio', audio: 'AA==' })), false)

    // A late context frame is legal: it must not reset the running session with another
    // session.update, and it must not fail the recognition either.
    client.emit('message', Buffer.from(JSON.stringify({ type: 'context', text: 'API session 路径' })), false)
    expect(messages(upstream).filter(message => message.type === 'session.update')).toHaveLength(1)
    expect(messages(client).some(message => message.type === 'error')).toBe(false)

    // Audio keeps flowing on the already-configured session.
    client.emit('message', Buffer.from(JSON.stringify({ type: 'audio', audio: 'BB==' })), false)
    const appends = messages(upstream).filter(message => message.type === 'input_audio_buffer.append')
    expect(appends.map(message => message.audio)).toEqual(['AA==', 'BB=='])
    expect(messages(upstream).filter(message => message.type === 'session.update')).toHaveLength(1)
  })

  it('rejects the client cleanly when the backend has no API key', () => {
    const client = new FakeSocket()
    const createUpstream = vi.fn()
    handleAsrRealtimeConnection(client as unknown as WebSocket, undefined, {
      apiKey: '',
      createUpstream,
    })
    expect(messages(client)[0].type).toBe('error')
    expect(client.closeCode).toBe(1011)
    expect(createUpstream).not.toHaveBeenCalled()
  })
})
