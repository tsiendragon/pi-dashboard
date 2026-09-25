/**
 * Voice output (text-to-speech) catalog shared by the backend TTS adapter and
 * the dashboard Settings / Live Session UI.
 *
 * The backend calls DashScope's non-realtime Qwen-TTS HTTP API
 * (`/api/v1/services/aigc/multimodal-generation/generation`); the realtime
 * (websocket) variants are intentionally not listed because that endpoint does
 * not serve them.
 */

export const TTS_DEFAULT_MODEL = 'qwen3-tts-flash'
export const TTS_DEFAULT_VOICE = 'Cherry'

/** DashScope caps a single non-realtime synthesis request; keep well under it. */
export const TTS_MAX_TEXT_CHARS = 2000

export interface TtsModelOption {
  id: string
  label: string
  /** Model accepts the `instructions` parameter (style prompt). */
  supportsInstructions?: boolean
}

export interface TtsVoiceOption {
  id: string
  label: string
  /** Only set where the vendor description is known; otherwise omitted. */
  hint?: string
}

export interface TtsLanguageOption {
  id: string
  label: string
}

/** `id: ''` means "let the model infer the language from the text". */
export const TTS_MODELS: TtsModelOption[] = [
  { id: 'qwen3-tts-flash', label: 'Qwen3 TTS Flash（默认 · 快）' },
  { id: 'qwen3-tts-instruct-flash', label: 'Qwen3 TTS Instruct Flash（可加风格指令）', supportsInstructions: true },
]

/**
 * Voice ids verified against the live DashScope endpoint (qwen3-tts-flash).
 * A wrong id is rejected by the provider, so only verified ids are listed;
 * users can still type a custom id from the vendor's voice list.
 */
export const TTS_VOICES: TtsVoiceOption[] = [
  { id: 'Cherry', label: 'Cherry', hint: '芊悦 · 阳光亲切女声（默认）' },
  { id: 'Ethan', label: 'Ethan' },
  { id: 'Serena', label: 'Serena' },
  { id: 'Vincent', label: 'Vincent' },
  { id: 'Bella', label: 'Bella' },
  { id: 'Arthur', label: 'Arthur' },
  { id: 'Neil', label: 'Neil' },
  { id: 'Aiden', label: 'Aiden' },
  { id: 'Nofish', label: 'Nofish' },
  { id: 'Jennifer', label: 'Jennifer' },
  { id: 'Ryan', label: 'Ryan' },
  { id: 'Katerina', label: 'Katerina' },
  { id: 'Elias', label: 'Elias' },
  { id: 'Jada', label: 'Jada' },
  { id: 'Dylan', label: 'Dylan' },
  { id: 'Sunny', label: 'Sunny' },
  { id: 'Li', label: 'Li' },
  { id: 'Marcus', label: 'Marcus' },
  { id: 'Roy', label: 'Roy' },
  { id: 'Peter', label: 'Peter' },
  { id: 'Rocky', label: 'Rocky' },
  { id: 'Kiki', label: 'Kiki' },
  { id: 'Eric', label: 'Eric' },
]

export const TTS_LANGUAGES: TtsLanguageOption[] = [
  { id: '', label: '自动（跟随文本）' },
  { id: 'Chinese', label: '中文' },
  { id: 'English', label: 'English' },
  { id: 'Japanese', label: '日本語' },
  { id: 'Korean', label: '한국어' },
  { id: 'French', label: 'Français' },
  { id: 'German', label: 'Deutsch' },
  { id: 'Spanish', label: 'Español' },
  { id: 'Portuguese', label: 'Português' },
  { id: 'Italian', label: 'Italiano' },
  { id: 'Russian', label: 'Русский' },
]

export interface TtsRequest {
  text: string
  model?: string
  voice?: string
  languageType?: string
  instructions?: string
}

/** GET /api/tts/config — lets Settings show a usable state before first use. */
export interface TtsConfigResponse {
  /** False when no DASHSCOPE_API_KEY is visible to the backend process. */
  available: boolean
  /** Human-readable reason when `available` is false. */
  reason?: string
  endpoint: string
  defaultModel: string
  defaultVoice: string
  maxTextChars: number
  models: TtsModelOption[]
  voices: TtsVoiceOption[]
  languages: TtsLanguageOption[]
}