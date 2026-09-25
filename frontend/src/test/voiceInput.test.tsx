/**
 * Voice input (speech-to-text) tests: the record → upload → transcript flow, the
 * settings-driven language, error mapping, and the Live Session composer wiring —
 * with fake MediaRecorder / getUserMedia / fetch, i.e. no microphone and no backend.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useVoiceInput } from '../features/voice/useVoiceInput'
import LiveSessionComposer from '../features/live-sessions/LiveSessionComposer'

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn(() => true)
  static clipBytes = 4096
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  state: 'inactive' | 'recording' = 'inactive'
  readonly mimeType: string

  constructor(readonly stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
    FakeMediaRecorder.instances.push(this)
  }

  start(): void { this.state = 'recording' }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array(FakeMediaRecorder.clipBytes)], { type: this.mimeType }) })
    this.onstop?.()
  }
}

const stopTrack = vi.fn()
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }))

function stubBrowserEnvironment(options: { recording?: boolean } = {}): void {
  if (options.recording !== false) vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
}

const okTranscription = (text = '帮我看下这个报错') => ({ ok: true, status: 200, json: async () => ({ text }) })

beforeEach(() => {
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.clipBytes = 4096
  FakeMediaRecorder.isTypeSupported.mockClear()
  stopTrack.mockClear()
  getUserMedia.mockClear()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('useVoiceInput', () => {
  it('reports browsers that cannot record', () => {
    stubBrowserEnvironment({ recording: false })
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.supported).toBe(false)

    act(() => result.current.toggle())
    expect(result.current.error).toContain('不支持录音')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('records a clip, uploads it, and returns the transcript', async () => {
    stubBrowserEnvironment()
    const fetchMock = vi.fn(async () => okTranscription())
    vi.stubGlobal('fetch', fetchMock)
    const onTranscript = vi.fn()

    const { result } = renderHook(() => useVoiceInput({ language: 'zh', onTranscript }))
    expect(result.current.supported).toBe(true)

    await act(async () => { result.current.toggle() })
    expect(result.current.listening).toBe(true)
    expect(FakeMediaRecorder.instances[0].state).toBe('recording')

    act(() => result.current.toggle())
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('帮我看下这个报错'))

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/asr/transcribe')
    const body = JSON.parse(String(init.body))
    expect(body.language).toBe('zh')
    expect(body.mime_type).toContain('audio/webm')
    expect(body.audio_base64.length).toBeGreaterThan(0)
    expect(result.current.listening).toBe(false)
    expect(result.current.transcribing).toBe(false)
    // The microphone must be released once the clip is captured.
    expect(stopTrack).toHaveBeenCalled()
  })

  it('drops legacy/unverified language codes instead of letting the provider 400', async () => {
    stubBrowserEnvironment()
    const fetchMock = vi.fn(async () => okTranscription())
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVoiceInput({ language: 'zh-CN' }))
    await act(async () => { result.current.toggle() })
    act(() => result.current.toggle())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.language).toBeUndefined()
  })

  it('explains microphone permission and capture failures', async () => {
    stubBrowserEnvironment()
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    const { result } = renderHook(() => useVoiceInput())

    await act(async () => { result.current.toggle() })
    expect(result.current.error).toContain('麦克风权限被拒绝')
    expect(result.current.listening).toBe(false)

    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFoundError' }))
    await act(async () => { result.current.toggle() })
    expect(result.current.error).toContain('没有检测到麦克风设备')
  })

  it('rejects clips that are too short and surfaces backend errors', async () => {
    stubBrowserEnvironment()
    const fetchMock = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ message: '没有识别到语音内容，请靠近麦克风再说一次。' }) }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVoiceInput())
    FakeMediaRecorder.clipBytes = 10
    await act(async () => { result.current.toggle() })
    act(() => result.current.toggle())
    expect(result.current.error).toContain('录音太短')
    expect(fetchMock).not.toHaveBeenCalled()

    FakeMediaRecorder.clipBytes = 4096
    await act(async () => { result.current.toggle() })
    act(() => result.current.toggle())
    await waitFor(() => expect(result.current.error).toContain('没有识别到语音内容'))

    act(() => result.current.clearError())
    expect(result.current.error).toBeUndefined()
  })
})

describe('LiveSessionComposer voice input', () => {
  it('records on the first tap and fills the composer on the second', async () => {
    stubBrowserEnvironment()
    const fetchMock = vi.fn(async () => okTranscription('帮我看下这个报错'))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<LiveSessionComposer status="idle" onSubmit={async () => {}} />)

    await user.click(screen.getByRole('button', { name: '开始语音输入' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止录音并识别' })).toHaveAttribute('aria-pressed', 'true'))

    await user.click(screen.getByRole('button', { name: '停止录音并识别' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('帮我看下这个报错'))

    // Default settings (Settings → Voice) mean Mandarin.
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.language).toBe('zh')
  })

  it('tells the user when the browser cannot record', async () => {
    stubBrowserEnvironment({ recording: false })
    const user = userEvent.setup()
    render(<LiveSessionComposer status="idle" onSubmit={async () => {}} />)

    const mic = screen.getByRole('button', { name: '开始语音输入' })
    expect(mic).toHaveAttribute('title', expect.stringContaining('不支持录音'))

    await user.click(mic)
    expect(await screen.findByRole('alert')).toHaveTextContent('当前浏览器不支持录音')
  })
})