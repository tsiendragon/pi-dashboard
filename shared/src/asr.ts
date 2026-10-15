/**
 * Voice input (speech-to-text) catalog shared by the backend ASR adapter and
 * the dashboard UI.
 *
 * Batch transcription uses DashScope's non-realtime Qwen-ASR HTTP API; live
 * voice input uses the separate realtime Qwen3-ASR WebSocket model. Both run
 * through the backend, so credentials are not exposed to browser speech services.
 */

export const ASR_DEFAULT_MODEL = 'qwen3-asr-flash'
export const ASR_REALTIME_MODEL = 'qwen3-asr-flash-realtime'
/** Batch endpoint browser recordings are uploaded base64-inline; keep under the JSON body limit. */
export const ASR_MAX_AUDIO_BYTES = 10 * 1024 * 1024

export interface AsrLanguageOption {
  id: string
  label: string
}

/** Language codes verified against the live endpoint. `''` = let the model detect it. */
export const ASR_LANGUAGES: AsrLanguageOption[] = [
  { id: '', label: '自动识别' },
  { id: 'zh', label: '中文（普通话）' },
  { id: 'yue', label: '中文（粤语）' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'pt', label: 'Português' },
  { id: 'ru', label: 'Русский' },
]

/**
 * Unknown codes fall back to auto-detect rather than reaching the provider: an
 * unrecognised code is a hard 400 there.
 */
export function normalizeAsrLanguage(value?: string): string {
  const trimmed = value?.trim() ?? ''
  return ASR_LANGUAGES.some(option => option.id === trimmed) ? trimmed : ''
}

export function asrLanguageLabel(value?: string): string {
  const id = normalizeAsrLanguage(value)
  return ASR_LANGUAGES.find(option => option.id === id)?.label ?? '自动识别'
}

export interface AsrRequest {
  audioBase64: string
  mimeType?: string
  /** Short code from ASR_LANGUAGES; ''/undefined = auto-detect. */
  language?: string
  model?: string
}

export interface AsrResult {
  text: string
  /** Language the provider detected. */
  language?: string
  model: string
  seconds?: number
}

/** GET /api/asr/config — lets the UI show a usable state before first use. */
export interface AsrConfigResponse {
  /** False when no DASHSCOPE_API_KEY is visible to the backend process. */
  available: boolean
  reason?: string
  endpoint: string
  /** Realtime ASR model used by the voice-input UI. */
  defaultModel: string
  maxAudioBytes: number
  languages: AsrLanguageOption[]
}