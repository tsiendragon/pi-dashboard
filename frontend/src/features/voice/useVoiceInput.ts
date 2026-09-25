import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeAsrLanguage } from '@shared/asr.js'

/**
 * Voice input (speech-to-text) for the dashboard.
 *
 * The browser only *records*; transcription happens on the backend via DashScope
 * (`/api/asr/transcribe`). The browser's own `SpeechRecognition` is deliberately
 * not used: it uploads audio to Google, exists only in Chromium, and fails with
 * `network` on restricted networks.
 */

/** Clips shorter than this almost always mean "nothing was said". */
const MIN_CLIP_BYTES = 1200
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  return PREFERRED_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type))
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('录音读取失败'))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const comma = dataUrl.indexOf(',')
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '')
    }
    reader.readAsDataURL(blob)
  })
}

function micErrorMessage(caught: unknown): string {
  const name = (caught as { name?: string } | undefined)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝：请在浏览器地址栏的站点权限里允许麦克风。'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有检测到麦克风设备。'
  if (name === 'NotReadableError') return '麦克风被其它程序占用，请关闭后重试。'
  return caught instanceof Error ? caught.message : '无法开始录音。'
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `语音识别失败（HTTP ${response.status}）`
  try {
    const payload = await response.json() as { message?: unknown; error?: unknown }
    if (typeof payload.message === 'string' && payload.message) return payload.message
    if (typeof payload.error === 'string' && payload.error) return payload.error
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  return fallback
}

export interface VoiceInputOptions {
  /** Short language code (see shared ASR_LANGUAGES); '' = auto-detect. */
  language?: string
  /** Override the backend ASR model. */
  model?: string
  /** Called once with the finished transcript. */
  onTranscript?: (text: string) => void
}

export interface VoiceInput {
  /** Microphone is recording right now. */
  listening: boolean
  /** A recorded clip is being transcribed. */
  transcribing: boolean
  /** False when the browser cannot record audio at all. */
  supported: boolean
  error: string | undefined
  /** Start recording, or finish + transcribe when already recording. */
  toggle: () => void
  stop: () => void
  clearError: () => void
}

export function useVoiceInput({ language, model, onTranscript }: VoiceInputOptions = {}): VoiceInput {
  const [supported] = useState(() => (
    typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
  ))
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string>()
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const callbacksRef = useRef(onTranscript)
  callbacksRef.current = onTranscript
  const settingsRef = useRef({ language, model })
  settingsRef.current = { language, model }

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  const upload = useCallback(async (blob: Blob, mimeType: string) => {
    setTranscribing(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const audioBase64 = await blobToBase64(blob)
      const response = await fetch('/api/asr/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_base64: audioBase64,
          mime_type: mimeType,
          language: normalizeAsrLanguage(settingsRef.current.language) || undefined,
          model: settingsRef.current.model || undefined,
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = await response.json() as { text?: unknown }
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text) throw new Error('没有识别到语音内容，请靠近麦克风再说一次。')
      callbacksRef.current?.(text)
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : '语音识别失败。')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (!controller.signal.aborted) setTranscribing(false)
    }
  }, [])

  const finish = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return
    setListening(false)
    try {
      recorder.stop()
    } catch {
      // Already stopped — onstop has run (or will) and cleans up.
    }
  }, [])

  const start = useCallback(async () => {
    if (typeof MediaRecorder === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setError('当前浏览器不支持录音（需要支持 MediaRecorder 的浏览器）。')
      return
    }
    setError(undefined)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = pickMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = event => { if (event.data?.size) chunksRef.current.push(event.data) }
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type })
        chunksRef.current = []
        releaseStream()
        if (blob.size < MIN_CLIP_BYTES) {
          setError('录音太短或没有声音，请按住多说一会儿。')
          return
        }
        void upload(blob, type)
      }
      recorderRef.current = recorder
      recorder.start()
      setListening(true)
    } catch (caught) {
      releaseStream()
      setListening(false)
      setError(micErrorMessage(caught))
    }
  }, [releaseStream, upload])

  const stop = useCallback(() => finish(), [finish])
  const toggle = useCallback(() => {
    if (recorderRef.current) finish()
    else void start()
  }, [finish, start])

  useEffect(() => () => {
    abortRef.current?.abort()
    try {
      recorderRef.current?.stop()
    } catch {
      // Nothing recording.
    }
    releaseStream()
  }, [releaseStream])

  const clearError = useCallback(() => setError(undefined), [])

  return { listening, transcribing, supported, error, toggle, stop, clearError }
}