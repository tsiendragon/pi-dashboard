import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanPolishedText,
  buildPolishMessages,
  polishTranscript,
} from '../asr-polish.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('ASR polish', () => {
  it('includes only a small explicit context and tells the model not to execute it', () => {
    const messages = buildPolishMessages('帮我检查这个 API', {
      title: '修复登录',
      cwd: '/work/app',
      draft: '先看 README',
      recent: [
        { role: 'user', text: '这个项目的登录在哪里？' },
        { role: 'assistant', text: '在 src/auth.ts。' },
        { role: 'user', text: 'x'.repeat(2_000) },
      ],
    })
    expect(messages[0].content).toContain('不是助手')
    expect(messages[1].content).toContain('会话标题：修复登录')
    expect(messages[1].content).toContain('工作目录：/work/app')
    expect(messages[1].content).toContain('当前输入草稿')
    expect(messages[1].content).toContain('待润色的语音转写')
    expect(messages[1].content).not.toContain('x'.repeat(1_000))
  })

  it('calls the OpenAI-compatible endpoint with a small token budget and returns cleaned text', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    vi.stubEnv('DASHSCOPE_ASR_POLISH_MODEL', 'qwen-small-test')
    const fetchImpl = vi.fn(async () => reply({
      choices: [{ message: { content: '润色后：帮我检查这个 API。' } }],
    })) as unknown as typeof fetch
    const result = await polishTranscript({ text: '帮我 check 这个 a p i' }, fetchImpl)
    expect(result).toMatchObject({ text: '帮我检查这个 API。', polished: true, model: 'qwen-small-test' })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/compatible-mode/v1/chat/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'qwen-small-test', max_tokens: 512 })
  })

  it('keeps slash commands byte-for-byte and never calls the model', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await polishTranscript({ text: '/skill:dashboard-ui-ux 改一下这里' }, fetchImpl)
    expect(result).toMatchObject({ text: '/skill:dashboard-ui-ux 改一下这里', polished: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('falls back to the original if a model returns an oversized explanation', () => {
    expect(cleanPolishedText('这是一个很长的解释'.repeat(100), '原文')).toBe('原文')
    expect(cleanPolishedText('', '原文')).toBe('原文')
  })

  it('reports a missing key and provider errors without leaking the payload', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    await expect(polishTranscript({ text: 'hello' })).rejects.toMatchObject({ code: 'asr_polish_api_key_missing' })
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    const fetchImpl = vi.fn(async () => reply({ error: { message: 'rate limited' } }, 429)) as unknown as typeof fetch
    await expect(polishTranscript({ text: 'hello' }, fetchImpl)).rejects.toMatchObject({
      code: 'asr_polish_provider_error',
      status: 502,
    })
  })
})
