import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendVoiceTranscript, floatAudioToPcm16, useVoiceInput } from '../features/voice/useVoiceInput'
import LiveSessionComposer from '../features/live-sessions/LiveSessionComposer'

class FakeProcessor {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()

  process(samples = new Float32Array([0, 0.25, -0.25, 1])): void {
    const inputBuffer = { getChannelData: () => samples } as unknown as AudioBuffer
    const outputBuffer = { getChannelData: () => new Float32Array(samples.length) } as unknown as AudioBuffer
    this.onaudioprocess?.({ inputBuffer, outputBuffer } as AudioProcessingEvent)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  readonly sampleRate = 16_000
  readonly destination = {} as AudioDestinationNode
  state: AudioContextState = 'running'
  processor?: FakeProcessor
  readonly source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode

  constructor() { FakeAudioContext.instances.push(this) }
  createMediaStreamSource(): MediaStreamAudioSourceNode { return this.source }
  createScriptProcessor(): ScriptProcessorNode {
    this.processor = new FakeProcessor()
    return this.processor as unknown as ScriptProcessorNode
  }
  resume = vi.fn(async () => {})
  close = vi.fn(async () => { this.state = 'closed' })
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
      this.receive({ type: 'ready' })
    })
  }

  send(message: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open')
    this.sent.push(message)
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }
}

const stopTrack = vi.fn()
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream))

function stubBrowserEnvironment(options: { audioContext?: boolean } = {}): void {
  if (options.audioContext !== false) {
    Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true })
    vi.stubGlobal('AudioContext', FakeAudioContext)
  } else {
    Reflect.deleteProperty(window, 'AudioContext')
  }
  vi.stubGlobal('WebSocket', FakeWebSocket)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('No realtime ASR socket was created')
  return socket
}

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeWebSocket.instances = []
  stopTrack.mockClear()
  getUserMedia.mockReset()
  getUserMedia.mockImplementation(async () => ({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream))
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'AudioContext')
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('voice text helpers', () => {
  it('preserves existing draft text and separates successive transcripts', () => {
    expect(appendVoiceTranscript('', 'first')).toBe('first')
    expect(appendVoiceTranscript('typed text', 'first')).toBe('typed text first')
    expect(appendVoiceTranscript('typed text ', 'first')).toBe('typed text first')
  })

  it('resamples mono audio to signed little-endian PCM16', () => {
    const bytes = floatAudioToPcm16(new Float32Array([-1, -0.5, 0, 0.5, 1]), 16_000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(Array.from({ length: 5 }, (_, index) => view.getInt16(index * 2, true)))
      .toEqual([-32768, -16384, 0, 16384, 32767])
  })
})

describe('useVoiceInput realtime streaming', () => {
  it('streams PCM chunks and exposes interim and final text separately', async () => {
    stubBrowserEnvironment()
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ language: 'zh', onTranscript }))

    act(() => result.current.toggle())
    await waitFor(() => expect(result.current.listening).toBe(true))
    expect(result.current.connecting).toBe(false)
    expect(latestSocket().url).toContain('/api/asr/realtime?language=zh')

    act(() => FakeAudioContext.instances[0].processor?.process())
    const audioMessage = latestSocket().sent.map(raw => JSON.parse(raw) as Record<string, unknown>)
      .find(message => message.type === 'audio')
    expect(audioMessage?.audio).toEqual(expect.any(String))

    act(() => latestSocket().receive({
      type: 'conversation.item.input_audio_transcription.text',
      text: '今天天气',
      stash: '不错',
    }))
    expect(result.current.interimTranscript).toBe('今天天气不错')

    act(() => latestSocket().receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '今天天气不错',
    }))
    expect(onTranscript).toHaveBeenCalledWith('今天天气不错')
    expect(result.current.interimTranscript).toBe('')

    act(() => result.current.stop())
    expect(result.current.transcribing).toBe(true)
    expect(latestSocket().sent.map(raw => JSON.parse(raw).type)).toContain('finish')
    act(() => latestSocket().receive({ type: 'finished' }))
    expect(result.current.listening).toBe(false)
    expect(result.current.transcribing).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(stopTrack).toHaveBeenCalled()
  })

  it('cancels microphone setup when sending before the realtime connection is ready', async () => {
    stubBrowserEnvironment()
    let resolveStream: ((stream: MediaStream) => void) | undefined
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { resolveStream = resolve }))
    const { result } = renderHook(() => useVoiceInput())

    act(() => result.current.toggle())
    expect(result.current.connecting).toBe(true)
    act(() => result.current.stop())
    expect(result.current.connecting).toBe(false)

    await act(async () => {
      resolveStream?.({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
      await Promise.resolve()
    })
    await waitFor(() => expect(stopTrack).toHaveBeenCalled())
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(result.current.error).toBeUndefined()
  })

  it('explains when the browser cannot capture streaming audio', () => {
    stubBrowserEnvironment({ audioContext: false })
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.supported).toBe(false)

    act(() => result.current.toggle())
    expect(result.current.error).toContain('不支持实时录音')
  })

  it('surfaces realtime service errors', async () => {
    stubBrowserEnvironment()
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.toggle())
    await waitFor(() => expect(result.current.listening).toBe(true))

    act(() => latestSocket().receive({ type: 'error', message: 'Realtime model unavailable' }))
    expect(result.current.error).toBe('Realtime model unavailable')
    expect(result.current.listening).toBe(false)
  })
})

describe('LiveSessionComposer realtime voice input', () => {
  it('appends successive dictated segments to the existing composer draft', async () => {
    stubBrowserEnvironment()
    const user = userEvent.setup()
    render(<LiveSessionComposer status="idle" onSubmit={async () => {}} />)
    const input = screen.getByRole('textbox')
    await user.type(input, '已有草稿')

    const dictate = async (text: string): Promise<void> => {
      await user.click(screen.getByRole('button', { name: '开始语音输入' }))
      await waitFor(() => expect(screen.getByRole('button', { name: '停止录音并识别' })).toHaveAttribute('aria-pressed', 'true'))
      const socket = latestSocket()
      await user.click(screen.getByRole('button', { name: '停止录音并识别' }))
      act(() => {
        socket.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: text })
        socket.receive({ type: 'finished' })
      })
    }

    await dictate('第一段语音')
    await waitFor(() => expect(input).toHaveValue('已有草稿 第一段语音'))
    await dictate('第二段语音')
    await waitFor(() => expect(input).toHaveValue('已有草稿 第一段语音 第二段语音'))
  })

  it('shows interim text while recording', async () => {
    stubBrowserEnvironment()
    const user = userEvent.setup()
    render(<LiveSessionComposer status="idle" onSubmit={async () => {}} />)
    await user.click(screen.getByRole('button', { name: '开始语音输入' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止录音并识别' })).toHaveAttribute('aria-pressed', 'true'))

    act(() => latestSocket().receive({
      type: 'conversation.item.input_audio_transcription.text',
      text: '正在说',
      stash: '话',
    }))
    expect(screen.getByRole('status')).toHaveTextContent('正在识别：正在说话')
  })
})
