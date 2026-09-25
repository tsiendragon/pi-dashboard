/**
 * Voice input (speech-to-text) catalog shared by the backend ASR adapter and
 * the dashboard UI.
 *
 * The dashboard transcribes on the backend via DashScope's non-realtime
 * Qwen-ASR HTTP API, so voice input no longer depends on the browser's cloud
 * speech service (which is Chromium-only and blocked on many networks).
 */

export const ASR_DEFAULT_MODEL = 'qwen3-asr-flash'
/** Browser recordings are uploaded base64-inline; keep well under the JSON body limit. */
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
  defaultModel: string
  maxAudioBytes: number
  languages: AsrLanguageOption[]
}