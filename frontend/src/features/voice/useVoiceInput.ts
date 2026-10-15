import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeAsrLanguage } from '@shared/asr.js'

const REALTIME_PATH = '/api/asr/realtime'
const REALTIME_SAMPLE_RATE = 16_000
const CONNECT_TIMEOUT_MS = 15_000

interface RealtimeCapture {
  socket?: WebSocket
  stream?: MediaStream
  context?: AudioContext
  source?: MediaStreamAudioSourceNode
  processor?: ScriptProcessorNode
  ready: boolean
  finishRequested: boolean
  finished: boolean
  cancelled: boolean
  hasTranscript: boolean
  hasError: boolean
  resolveReady?: () => void
  rejectReady?: (error: Error) => void
}

function micErrorMessage(caught: unknown): string {
  const name = (caught as { name?: string } | undefined)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝：请在浏览器地址栏的站点权限里允许麦克风。'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有检测到麦克风设备。'
  if (name === 'NotReadableError') return '麦克风被其它程序占用，请关闭后重试。'
  return caught instanceof Error ? caught.message : '无法开始实时录音。'
}

function errorText(payload: Record<string, unknown>): string {
  if (typeof payload.message === 'string' && payload.message) return payload.message
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return '实时语音识别失败，请重试。'
}

function appendBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

/** Resample mono Float32 audio and encode signed little-endian PCM16 for DashScope. */
export function floatAudioToPcm16(samples: Float32Array, inputRate: number, outputRate = REALTIME_SAMPLE_RATE): Uint8Array {
  if (inputRate <= 0 || outputRate <= 0) throw new Error('音频采样率无效。')
  const ratio = inputRate / outputRate
  const outputLength = Math.floor(samples.length / ratio)
  const buffer = new ArrayBuffer(outputLength * 2)
  const view = new DataView(buffer)

  for (let index = 0; index < outputLength; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * ratio)))
    let sum = 0
    for (let sourceIndex = start; sourceIndex < end; sourceIndex++) sum += samples[sourceIndex]
    const value = Math.max(-1, Math.min(1, sum / (end - start)))
    view.setInt16(index * 2, Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), true)
  }
  return new Uint8Array(buffer)
}

function releaseAudio(capture: RealtimeCapture): void {
  if (capture.processor) {
    capture.processor.onaudioprocess = null
    capture.processor.disconnect()
    capture.processor = undefined
  }
  capture.source?.disconnect()
  capture.source = undefined
  capture.stream?.getTracks().forEach(track => track.stop())
  capture.stream = undefined
  if (capture.context && capture.context.state !== 'closed') {
    void capture.context.close().catch(() => {})
  }
  capture.context = undefined
}

/** Append a completed speech transcript without replacing the user's existing draft. */
export function appendVoiceTranscript(current: string, transcript: string): string {
  if (!current || !/\S/.test(current)) return `${current}${transcript}`
  return `${current}${/\s$/.test(current) ? '' : ' '}${transcript}`
}

export interface VoiceInputOptions {
  /** Short language code (see shared ASR_LANGUAGES); '' = auto-detect. */
  language?: string
  /** Called once with each completed speech segment. */
  onTranscript?: (text: string) => void
}

export interface VoiceInput {
  /** Microphone is recording right now. */
  listening: boolean
  /** The realtime connection is being established. */
  connecting: boolean
  /** Waiting for the final transcription after recording stopped. */
  transcribing: boolean
  /** Current provisional words; final text is delivered through onTranscript. */
  interimTranscript: string
  /** False when the browser cannot capture and stream audio. */
  supported: boolean
  error: string | undefined
  /** Start recording, or finish + transcribe when already recording. */
  toggle: () => void
  stop: () => void
  clearError: () => void
}

export function useVoiceInput({ language, onTranscript }: VoiceInputOptions = {}): VoiceInput {
  const [supported] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.AudioContext === 'function'
    && typeof WebSocket !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
  ))
  const [listening, setListening] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string>()
  const captureRef = useRef<RealtimeCapture | null>(null)
  const startingRef = useRef(false)
  const callbacksRef = useRef(onTranscript)
  callbacksRef.current = onTranscript
  const languageRef = useRef(language)
  languageRef.current = language

  const finishCapture = useCallback((capture: RealtimeCapture, closeSocket: boolean) => {
    releaseAudio(capture)
    if (captureRef.current === capture) captureRef.current = null
    if (closeSocket && capture.socket && capture.socket.readyState < WebSocket.CLOSING) {
      capture.socket.close(1000, 'voice input finished')
    }
  }, [])

  const receiveServerMessage = useCallback((capture: RealtimeCapture, data: unknown) => {
    if (typeof data !== 'string') return
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      payload = parsed as Record<string, unknown>
    } catch {
      return
    }

    if (payload.type === 'ready') {
      capture.ready = true
      capture.resolveReady?.()
      return
    }
    if (payload.type === 'error' || payload.type === 'conversation.item.input_audio_transcription.failed') {
      capture.hasError = true
      const message = errorText(payload)
      setError(message)
      setInterimTranscript('')
      if (!capture.ready) capture.rejectReady?.(new Error(message))
      else {
        capture.finished = true
        setListening(false)
        setConnecting(false)
        setTranscribing(false)
        finishCapture(capture, true)
      }
      return
    }
    if (payload.type === 'conversation.item.input_audio_transcription.text') {
      const text = typeof payload.text === 'string' ? payload.text : ''
      const stash = typeof payload.stash === 'string' ? payload.stash : ''
      setInterimTranscript(`${text}${stash}`)
      return
    }
    if (payload.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : ''
      setInterimTranscript('')
      if (transcript) {
        capture.hasTranscript = true
        callbacksRef.current?.(transcript)
      }
      return
    }
    if (payload.type === 'finished') {
      capture.finished = true
      setInterimTranscript('')
      if (!capture.hasTranscript && !capture.hasError) setError('没有识别到语音内容，请靠近麦克风再说一次。')
      setListening(false)
      setConnecting(false)
      setTranscribing(false)
      finishCapture(capture, true)
    }
  }, [finishCapture])

  const start = useCallback(async () => {
    if (!supported || startingRef.current || captureRef.current) {
      if (!supported) setError('当前浏览器不支持实时录音（需要麦克风、AudioContext 和 WebSocket）。')
      return
    }
    startingRef.current = true
    setError(undefined)
    setInterimTranscript('')
    setConnecting(true)
    setTranscribing(false)

    const capture: RealtimeCapture = {
      ready: false,
      finishRequested: false,
      finished: false,
      cancelled: false,
      hasTranscript: false,
      hasError: false,
    }
    captureRef.current = capture

    try {
      const AudioContextConstructor = window.AudioContext
      if (!AudioContextConstructor) throw new Error('当前浏览器不支持 AudioContext。')
      capture.context = new AudioContextConstructor()
      const streamPromise = navigator.mediaDevices.getUserMedia({ audio: true })
      const resumePromise = capture.context.resume()
      capture.stream = await streamPromise
      await resumePromise
      if (captureRef.current !== capture) {
        releaseAudio(capture)
        return
      }

      const url = new URL(REALTIME_PATH, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const normalizedLanguage = normalizeAsrLanguage(languageRef.current)
      if (normalizedLanguage) url.searchParams.set('language', normalizedLanguage)
      capture.socket = new WebSocket(url.toString())

      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接实时语音识别服务超时。')), CONNECT_TIMEOUT_MS)
        capture.resolveReady = () => { clearTimeout(timeout); resolve() }
        capture.rejectReady = reason => { clearTimeout(timeout); reject(reason) }
      })
      capture.socket.onmessage = event => receiveServerMessage(capture, event.data)
      capture.socket.onerror = () => {
        if (!capture.ready) capture.rejectReady?.(new Error('实时语音连接失败，请检查网络后重试。'))
      }
      capture.socket.onclose = () => {
        if (capture.finished || captureRef.current !== capture) return
        if (!capture.ready) capture.rejectReady?.(new Error('实时语音连接已中断，请重试。'))
        if (!capture.hasError) setError('实时语音连接已中断，请重试。')
        setInterimTranscript('')
        setListening(false)
        setConnecting(false)
        setTranscribing(false)
        capture.finished = true
        finishCapture(capture, false)
      }

      await ready
      if (captureRef.current !== capture || !capture.context || !capture.stream) return

      capture.source = capture.context.createMediaStreamSource(capture.stream)
      capture.processor = capture.context.createScriptProcessor(2048, 1, 1)
      capture.processor.onaudioprocess = event => {
        const output = event.outputBuffer.getChannelData(0)
        output.fill(0)
        if (!capture.ready || capture.finishRequested || capture.socket?.readyState !== WebSocket.OPEN) return
        const pcm = floatAudioToPcm16(event.inputBuffer.getChannelData(0), capture.context!.sampleRate)
        if (pcm.length === 0) return
        capture.socket.send(JSON.stringify({ type: 'audio', audio: appendBase64(pcm) }))
      }
      capture.source.connect(capture.processor)
      capture.processor.connect(capture.context.destination)
      setConnecting(false)
      setListening(true)
    } catch (caught) {
      capture.finished = true
      setConnecting(false)
      setListening(false)
      setTranscribing(false)
      if (!capture.cancelled) setError(micErrorMessage(caught))
      finishCapture(capture, true)
    } finally {
      startingRef.current = false
    }
  }, [finishCapture, receiveServerMessage, supported])

  const stop = useCallback(() => {
    const capture = captureRef.current
    if (!capture || capture.finishRequested || capture.finished) return
    if (!capture.ready) {
      capture.cancelled = true
      capture.finished = true
      capture.rejectReady?.(new Error('Realtime capture cancelled.'))
      setInterimTranscript('')
      setConnecting(false)
      setListening(false)
      setTranscribing(false)
      finishCapture(capture, true)
      return
    }
    capture.finishRequested = true
    setListening(false)
    setTranscribing(true)
    releaseAudio(capture)
    if (capture.socket?.readyState === WebSocket.OPEN) {
      capture.socket.send(JSON.stringify({ type: 'finish' }))
    } else {
      capture.hasError = true
      capture.finished = true
      setError('实时语音连接已断开，请重新录音。')
      setTranscribing(false)
      finishCapture(capture, true)
    }
  }, [finishCapture])

  const toggle = useCallback(() => {
    const capture = captureRef.current
    if (capture) {
      if (capture.ready && !capture.finishRequested) stop()
      return
    }
    void start()
  }, [start, stop])

  useEffect(() => () => {
    const capture = captureRef.current
    if (!capture) return
    capture.finished = true
    finishCapture(capture, true)
  }, [finishCapture])

  const clearError = useCallback(() => setError(undefined), [])

  return { listening, connecting, transcribing, interimTranscript, supported, error, toggle, stop, clearError }
}
