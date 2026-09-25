import { useCallback, useEffect, useRef, useState } from 'react'
import { splitForSpeech, toSpeechText } from './speechText'
import type { TtsSettings } from './ttsSettings'

export interface VoiceOutput {
  /** Speak `text` (markdown ok); replaces whatever is currently playing. */
  speak: (text: string, settings: TtsSettings) => Promise<void>
  stop: () => void
  speaking: boolean
  error: string | undefined
  clearError: () => void
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `语音合成失败（HTTP ${response.status}）`
  try {
    const payload = await response.json() as { message?: unknown; error?: unknown }
    if (typeof payload.message === 'string' && payload.message) return payload.message
    if (typeof payload.error === 'string' && payload.error) return payload.error
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  return fallback
}

/**
 * Plays DashScope-synthesized speech for the dashboard.
 *
 * Audio comes from the backend as raw bytes so playback stays same-origin (the
 * provider hands out a short-lived http link). Because provider latency grows
 * with the text, the reply is split into sentence-sized chunks that are fetched
 * one ahead of playback: the first words start playing while the next chunk is
 * still being synthesized.
 */
export function useVoiceOutput(): VoiceOutput {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlsRef = useRef<string[]>([])
  const controllersRef = useRef<AbortController[]>([])
  const finishPlaybackRef = useRef<(() => void) | null>(null)
  const runRef = useRef(0)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string>()

  const release = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort()
    controllersRef.current = []
    finishPlaybackRef.current?.()
    finishPlaybackRef.current = null
    const audio = audioRef.current
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audioRef.current = null
    }
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
    objectUrlsRef.current = []
  }, [])

  const stop = useCallback(() => {
    runRef.current += 1
    release()
    setSpeaking(false)
  }, [release])

  useEffect(() => release, [release])

  const requestAudio = useCallback(async (chunk: string, settings: TtsSettings): Promise<Blob> => {
    const controller = new AbortController()
    controllersRef.current.push(controller)
    const response = await fetch('/api/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: chunk,
        model: settings.model || undefined,
        voice: settings.voice || undefined,
        language_type: settings.languageType || undefined,
        instructions: settings.instructions || undefined,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await errorMessage(response))
    return response.blob()
  }, [])

  const play = useCallback((blob: Blob, run: number) => new Promise<void>(resolve => {
    const url = URL.createObjectURL(blob)
    objectUrlsRef.current.push(url)
    const audio = new Audio(url)
    audioRef.current = audio
    const finish = () => {
      const index = objectUrlsRef.current.indexOf(url)
      if (index >= 0) {
        objectUrlsRef.current.splice(index, 1)
        URL.revokeObjectURL(url)
      }
      if (audioRef.current === audio) audioRef.current = null
      if (finishPlaybackRef.current === finish) finishPlaybackRef.current = null
      resolve()
    }
    finishPlaybackRef.current = finish
    audio.onended = finish
    audio.onerror = () => {
      if (run === runRef.current) setError('音频播放失败。')
      finish()
    }
    void audio.play().catch((caught: unknown) => {
      if (run === runRef.current) setError(caught instanceof Error ? caught.message : '音频播放失败。')
      finish()
    })
  }), [])

  const speak = useCallback(async (text: string, settings: TtsSettings) => {
    const chunks = splitForSpeech(toSpeechText(text))
    if (chunks.length === 0) return

    runRef.current += 1
    const run = runRef.current
    release()
    setError(undefined)
    setSpeaking(true)

    let pending = requestAudio(chunks[0], settings)
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const blob = await pending
        if (run !== runRef.current) return
        if (index + 1 < chunks.length) {
          pending = requestAudio(chunks[index + 1], settings)
          // The next chunk is fetched while this one plays; keep its rejection
          // from surfacing as an unhandled error until we await it.
          pending.catch(() => {})
        }
        await play(blob, run)
        if (run !== runRef.current) return
      }
      setSpeaking(false)
    } catch (caught) {
      if (run !== runRef.current) return
      release()
      setSpeaking(false)
      setError(caught instanceof Error ? caught.message : '语音合成失败')
    }
  }, [play, release, requestAudio])

  const clearError = useCallback(() => setError(undefined), [])

  return { speak, stop, speaking, error, clearError }
}