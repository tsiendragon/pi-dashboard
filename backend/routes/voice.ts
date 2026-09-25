import type { Express, Request, Response } from 'express'
import {
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  TTS_LANGUAGES,
  TTS_MAX_TEXT_CHARS,
  TTS_MODELS,
  TTS_VOICES,
  type TtsConfigResponse,
} from '../../shared/src/tts.js'
import {
  ASR_DEFAULT_MODEL,
  ASR_LANGUAGES,
  ASR_MAX_AUDIO_BYTES,
  normalizeAsrLanguage,
  type AsrConfigResponse,
} from '../../shared/src/asr.js'
import { resolveDashscopeBaseUrl } from '../dashscope.js'
import { AsrError, asrAvailability, transcribeAudio } from '../asr.js'
import { TtsError, synthesizeSpeech, ttsAvailability } from '../tts.js'

export interface VoiceRouteOptions {
  app: Express
}

/** Base64 payload size in bytes (ignoring padding), for the upload limit check. */
function base64Bytes(value: string): number {
  const clean = value.replace(/\s+/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/**
 * Voice endpoints: output (`/api/tts/*`) and input (`/api/asr/*`).
 *
 * Authentication follows the rest of the dashboard mutation API: no token, but
 * the global origin guard in server.ts rejects cross-site POSTs, and the server
 * is bound to the Tailscale interface.
 */
export function registerVoiceRoutes({ app }: VoiceRouteOptions): void {
  app.get('/api/tts/config', (_req: Request, res: Response) => {
    const availability = ttsAvailability()
    const body: TtsConfigResponse = {
      ...availability,
      endpoint: resolveDashscopeBaseUrl(),
      defaultModel: TTS_DEFAULT_MODEL,
      defaultVoice: TTS_DEFAULT_VOICE,
      maxTextChars: TTS_MAX_TEXT_CHARS,
      models: TTS_MODELS,
      voices: TTS_VOICES,
      languages: TTS_LANGUAGES,
    }
    res.json(body)
  })

  app.post('/api/tts/speak', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const audio = await synthesizeSpeech({
        text: typeof body.text === 'string' ? body.text : '',
        model: typeof body.model === 'string' ? body.model : undefined,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        languageType: typeof body.language_type === 'string' ? body.language_type : undefined,
        instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      })
      res.setHeader('Content-Type', audio.contentType)
      res.setHeader('Content-Length', String(audio.bytes.length))
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Tts-Model', audio.model)
      res.setHeader('X-Tts-Voice', audio.voice)
      res.setHeader('X-Tts-Truncated', audio.truncated ? '1' : '0')
      res.send(audio.bytes)
    } catch (error) {
      const ttsError = error instanceof TtsError ? error : new TtsError('tts_failed', error instanceof Error ? error.message : String(error), 500)
      console.error(`[tts] synthesis failed (${ttsError.code}):`, ttsError.message)
      res.status(ttsError.status).json({ error: ttsError.code, message: ttsError.message })
    }
  })

  app.get('/api/asr/config', (_req: Request, res: Response) => {
    const availability = asrAvailability()
    const body: AsrConfigResponse = {
      ...availability,
      endpoint: resolveDashscopeBaseUrl(),
      defaultModel: ASR_DEFAULT_MODEL,
      maxAudioBytes: ASR_MAX_AUDIO_BYTES,
      languages: ASR_LANGUAGES,
    }
    res.json(body)
  })

  app.post('/api/asr/transcribe', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const audioBase64 = typeof body.audio_base64 === 'string' ? body.audio_base64 : ''
    try {
      if (audioBase64 && base64Bytes(audioBase64) > ASR_MAX_AUDIO_BYTES) {
        throw new AsrError('asr_audio_too_large', `录音过大（上限 ${Math.floor(ASR_MAX_AUDIO_BYTES / (1024 * 1024))} MiB），请缩短后再试。`, 413)
      }
      const result = await transcribeAudio({
        audioBase64,
        mimeType: typeof body.mime_type === 'string' ? body.mime_type : undefined,
        language: typeof body.language === 'string' ? normalizeAsrLanguage(body.language) : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
      })
      res.setHeader('Cache-Control', 'no-store')
      res.json(result)
    } catch (error) {
      const asrError = error instanceof AsrError ? error : new AsrError('asr_failed', error instanceof Error ? error.message : String(error), 500)
      console.error(`[asr] transcription failed (${asrError.code}):`, asrError.message)
      res.status(asrError.status).json({ error: asrError.code, message: asrError.message })
    }
  })
}