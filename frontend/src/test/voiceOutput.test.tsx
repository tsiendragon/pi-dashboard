/**
 * Voice output (TTS) unit tests: the settings store, the markdown→speech
 * cleanup + chunking, the live-session "last assistant reply" picker, and the
 * playback hook (chunked fetch/prefetch + audio lifecycle), all without a real
 * provider call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { TTS_DEFAULTS, loadTtsSettings, saveTtsSettings, subscribeTtsSettings } from '../features/voice/ttsSettings'
import { splitForSpeech, toSpeechText } from '../features/voice/speechText'
import { useVoiceOutput } from '../features/voice/useVoiceOutput'
import { lastAssistantSpeechText } from '../features/live-sessions/LiveSessionPage'
import { INITIAL_TURN_SPEECH_GATE, advanceTurnSpeech, takePendingSpeech, type TurnSpeechGate } from '../features/voice/turnSpeech'

describe('ttsSettings', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('returns defaults when nothing is stored', () => {
    expect(loadTtsSettings()).toEqual(TTS_DEFAULTS)
    expect(TTS_DEFAULTS.model).toBe('qwen3-tts-flash')
    expect(TTS_DEFAULTS.voice).toBe('Cherry')
    expect(TTS_DEFAULTS.enabled).toBe(false)
    expect(TTS_DEFAULTS.sttLanguage).toBe('zh')
  })

  it('round-trips saved settings and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTtsSettings(listener)
    const next = { ...TTS_DEFAULTS, enabled: true, voice: 'Ethan', languageType: 'Chinese' }
    saveTtsSettings(next)

    expect(loadTtsSettings()).toEqual(next)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('survives corrupt stored JSON', () => {
    localStorage.setItem('mc-tts-config', '{not json')
    expect(loadTtsSettings()).toEqual(TTS_DEFAULTS)
  })
})

describe('toSpeechText', () => {
  it('drops code blocks and markup that should not be read aloud', () => {
    const spoken = toSpeechText([
      '# 结论',
      '已完成 **主要** 改动，见 `src/a.ts`。',
      '```ts',
      'const a = 1',
      '```',
      '- 第一点',
      '- 第二点',
      '[文档](https://example.com/doc) 里说明了 https://example.com/x。',
      '',
      '| a | b |',
      '| - | - |',
    ].join('\n'))

    expect(spoken).not.toContain('const a')
    expect(spoken).not.toContain('**')
    expect(spoken).not.toContain('src/a.ts')
    expect(spoken).not.toContain('https://')
    expect(spoken).toContain('结论')
    expect(spoken).toContain('已完成 主要 改动')
    expect(spoken).toContain('文档 里说明了 链接。')
  })
})

describe('splitForSpeech', () => {
  it('returns nothing for blank input', () => {
    expect(splitForSpeech('   ')).toEqual([])
    expect(splitForSpeech('')).toEqual([])
  })

  it('keeps short text in one chunk and splits long text on sentences', () => {
    expect(splitForSpeech('第一句。第二句。')).toEqual(['第一句。第二句。'])

    const chunks = splitForSpeech('这是一个句子。'.repeat(40), 50)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 50)).toBe(true)
    expect(chunks.join('')).toBe('这是一个句子。'.repeat(40))
  })

  it('hard-splits a sentence longer than the chunk limit', () => {
    const chunks = splitForSpeech('x'.repeat(250), 100)
    expect(chunks.map(chunk => chunk.length)).toEqual([100, 100, 50])
  })
})

describe('lastAssistantSpeechText', () => {
  const assistant = (text: string) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const user = (text: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })

  it('returns the newest assistant reply, skipping tool results', () => {
    expect(lastAssistantSpeechText([
      user('问题'),
      assistant('第一次回复'),
      { type: 'tool_execution_end', data: { toolName: 'bash', result: 'ok' } },
      assistant('最终回复'),
    ])).toBe('最终回复')
  })

  it('returns empty text when the transcript has no assistant reply', () => {
    expect(lastAssistantSpeechText([user('只问了问题')])).toBe('')
    expect(lastAssistantSpeechText([])).toBe('')
  })
})

describe('turnSpeech gate', () => {
  /**
   * Replays (busy, text) observations through the same helpers the Live Session
   * page uses, including its "only scan the transcript when it may matter"
   * short-circuit, so a single turn-ending update must be enough to speak.
   */
  function drive(steps: { busy: boolean; spoken: string; enabled?: boolean }[]): string[] {
    let gate: TurnSpeechGate = INITIAL_TURN_SPEECH_GATE
    let lastSpoken = ''
    const spokenOut: string[] = []
    for (const step of steps) {
      const needsText = step.busy || gate.pending || gate.previousBusy === true
      const spoken = needsText ? step.spoken : ''
      gate = advanceTurnSpeech(gate, step.busy, spoken)
      const decision = takePendingSpeech(gate, step.busy, step.enabled ?? true, spoken, lastSpoken)
      gate = decision.gate
      if (decision.speak) { spokenOut.push(decision.speak); lastSpoken = decision.speak }
    }
    return spokenOut
  }

  it('reads the reply on the very update where the turn ends', () => {
    expect(drive([
      { busy: true, spoken: '上一轮' },
      { busy: false, spoken: '本轮回复' },
    ])).toEqual(['本轮回复'])
  })

  it('does not replay a reply when the page opens on an idle session', () => {
    expect(drive([{ busy: false, spoken: '旧回复' }])).toEqual([])
  })

  it('speaks once a turn goes busy → idle', () => {
    expect(drive([
      { busy: true, spoken: '旧回复' },
      { busy: false, spoken: '旧回复' },
      { busy: false, spoken: '本轮回复' },
    ])).toEqual(['本轮回复'])
  })

  it('never reads the pre-turn reply again at the turn boundary', () => {
    expect(drive([
      { busy: false, spoken: '旧回复' },
      { busy: true, spoken: '旧回复' },
      { busy: false, spoken: '旧回复' },
    ])).toEqual([])
  })

  it('waits for the transcript when the reply arrives after the turn ends', () => {
    expect(drive([
      { busy: true, spoken: '' },
      { busy: false, spoken: '' },
      { busy: false, spoken: '迟到的回复' },
    ])).toEqual(['迟到的回复'])
  })

  it('does not speak the same reply twice and drops pending work when disabled', () => {
    expect(drive([
      { busy: true, spoken: '' },
      { busy: false, spoken: '相同回复' },
      { busy: true, spoken: '相同回复' },
      { busy: false, spoken: '相同回复' },
    ])).toEqual(['相同回复'])

    expect(drive([
      { busy: true, spoken: '' },
      { busy: false, spoken: '不该读', enabled: false },
      { busy: false, spoken: '不该读' },
    ])).toEqual([])
  })

  it('ignores idle updates that were never preceded by a busy turn', () => {
    expect(drive([
      { busy: false, spoken: '' },
      { busy: false, spoken: '历史回复' },
    ])).toEqual([])
  })
})

class FakeAudio {
  static instances: FakeAudio[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly src: string) { FakeAudio.instances.push(this) }
  play(): Promise<void> { return Promise.resolve() }
  pause(): void {}
}

const originalCreateObjectURL = URL.createObjectURL

beforeEach(() => {
  FakeAudio.instances = []
  let objectUrlSeq = 0
  vi.stubGlobal('Audio', FakeAudio)
  Object.defineProperty(URL, 'createObjectURL', { value: () => `blob:fake-${++objectUrlSeq}`, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true })
})

const okBlob = () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([1, 2])]) })

function requestBodies(fetchMock: { mock: { calls: unknown[][] } }): Record<string, string>[] {
  return fetchMock.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)))
}

describe('useVoiceOutput', () => {
  const settings = { ...TTS_DEFAULTS, voice: 'Ethan', languageType: 'Chinese' }

  it('posts the settings to /api/tts/speak and plays the returned audio', async () => {
    const fetchMock = vi.fn(async () => okBlob())
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVoiceOutput())
    let promise: Promise<void>
    act(() => { promise = result.current.speak('你好，世界。', settings) })

    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tts/speak')
    expect(requestBodies(fetchMock)[0]).toEqual({
      text: '你好，世界。',
      model: settings.model,
      voice: 'Ethan',
      language_type: 'Chinese',
      instructions: undefined,
    })

    act(() => { FakeAudio.instances[0].onended?.() })
    await act(async () => { await promise! })

    expect(result.current.speaking).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it('strips markdown before sending the text', async () => {
    const fetchMock = vi.fn(async () => okBlob())
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVoiceOutput())
    let promise: Promise<void>
    act(() => { promise = result.current.speak('**重点**：见 `a.ts`', settings) })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const text = requestBodies(fetchMock)[0].text
    expect(text).toContain('重点')
    expect(text).not.toContain('**')
    expect(text).not.toContain('a.ts')

    act(() => { FakeAudio.instances[0]?.onended?.() })
    await act(async () => { await promise! })
  })

  it('chunks a long reply and prefetches the next chunk while the first plays', async () => {
    const fetchMock = vi.fn(async () => okBlob())
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVoiceOutput())
    let promise: Promise<void>
    const long = '这是一个较长的句子，用来验证分段朗读。'.repeat(30)
    act(() => { promise = result.current.speak(long, settings) })

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
    const texts = requestBodies(fetchMock).map(body => body.text)
    expect(texts.every(text => text.length <= 400)).toBe(true)
    expect(texts.join('')).toBe(long)

    act(() => result.current.stop())
    await act(async () => { await promise! })
    expect(result.current.speaking).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it('skips empty text and surfaces backend errors', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: '声码器不可用' }) }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useVoiceOutput())
    await act(async () => { await result.current.speak('   ', settings) })
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => { await result.current.speak('你好', settings) })
    expect(result.current.error).toBe('声码器不可用')
    expect(result.current.speaking).toBe(false)

    act(() => result.current.clearError())
    expect(result.current.error).toBeUndefined()
  })

  it('stop() cancels playback and clears the speaking flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okBlob()))
    const { result } = renderHook(() => useVoiceOutput())

    let promise: Promise<void>
    act(() => { promise = result.current.speak('你好', settings) })
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1))
    expect(result.current.speaking).toBe(true)

    act(() => result.current.stop())
    await act(async () => { await promise! })

    expect(result.current.speaking).toBe(false)
  })
})