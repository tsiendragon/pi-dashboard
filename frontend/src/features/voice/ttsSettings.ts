/** Shared voice-output (TTS) preferences, persisted per browser. */
import { TTS_DEFAULT_MODEL, TTS_DEFAULT_VOICE } from '@shared/tts.js'

export interface TtsSettings {
  /** Read assistant replies aloud automatically when a turn finishes. */
  enabled: boolean
  model: string
  voice: string
  /** '' = let the model infer the language from the text. */
  languageType: string
  /** Optional style prompt; only sent for instruct models. */
  instructions: string
  /** Voice-input (speech-to-text) language code; see shared ASR_LANGUAGES. */
  sttLanguage: string
}

const LS_KEY = 'mc-tts-config'
const LS_EVENT = 'mc-tts-config'

/** Speech is synthesized in chunks of this size (see splitForSpeech). */
export const TTS_CHUNK_CHARS = 400

export const TTS_DEFAULTS: TtsSettings = {
  enabled: false,
  model: TTS_DEFAULT_MODEL,
  voice: TTS_DEFAULT_VOICE,
  languageType: '',
  instructions: '',
  // Voice input defaults to Mandarin; override in Settings → Voice.
  sttLanguage: 'zh',
}

export function loadTtsSettings(): TtsSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Partial<TtsSettings>
    return { ...TTS_DEFAULTS, ...raw }
  } catch {
    return { ...TTS_DEFAULTS }
  }
}

export function saveTtsSettings(settings: TtsSettings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(settings))
  // Broadcast so an open Live Session picks up Settings changes immediately.
  window.dispatchEvent(new CustomEvent(LS_EVENT))
}

/** Subscribe to changes made in this tab or another one. */
export function subscribeTtsSettings(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === LS_KEY) listener() }
  window.addEventListener(LS_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(LS_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}