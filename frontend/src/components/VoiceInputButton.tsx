import { appendVoiceTranscript, useVoiceInput } from '../features/voice/useVoiceInput'

/** Mic button + live status line; transcripts are appended to the caller's text via `onAppend`. */
export function VoiceInputButton({ language, onAppend }: { language?: string; onAppend: (update: (current: string) => string) => void }) {
  const voiceInput = useVoiceInput({
    language,
    onTranscript: text => onAppend(current => appendVoiceTranscript(current, text)),
  })
  return (
    <>
      <button
        type="button"
        aria-label={voiceInput.listening ? '结束录音并识别' : voiceInput.connecting ? '正在连接语音识别' : voiceInput.transcribing ? '正在完成识别' : '开始语音输入'}
        aria-pressed={voiceInput.listening}
        title={voiceInput.supported ? '点击开始实时录音，再点一次结束并确认文字' : '当前浏览器不支持实时录音'}
        className="cursor-pointer rounded border border-border px-2 py-0.5 text-2xs text-muted disabled:cursor-default disabled:opacity-40"
        disabled={!voiceInput.supported || voiceInput.connecting || voiceInput.transcribing}
        onClick={voiceInput.toggle}
      >{voiceInput.listening ? '⏹ 结束录音' : voiceInput.connecting ? '连接中…' : voiceInput.transcribing ? '整理文字…' : '🎙 语音输入'}</button>
      {voiceInput.interimTranscript && <span role="status" aria-live="polite" className="w-full text-2xs text-muted">正在识别：{voiceInput.interimTranscript}</span>}
      {voiceInput.error && <span role="alert" className="w-full text-2xs text-danger">{voiceInput.error}</span>}
    </>
  )
}
