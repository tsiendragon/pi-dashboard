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
    expect(messages.system).toContain('不是助手')
    expect(messages.user).toContain('会话标题：修复登录')
    expect(messages.user).toContain('工作目录：/work/app')
    expect(messages.user).toContain('当前输入草稿')
    expect(messages.user).toContain('待润色的语音转写')
    expect(messages.user).not.toContain('x'.repeat(1_000))
  })

  it('uses DeepSeek V4.1 Flash with high thinking as the primary model', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    vi.stubEnv('DASHSCOPE_ASR_POLISH_MODEL', 'deepseek-v4.1-flash-1017')
    const fetchImpl = vi.fn(async () => reply({
      choices: [{ message: { content: '润色后：帮我检查这个 API。' } }],
    })) as unknown as typeof fetch
    const result = await polishTranscript({ text: '帮我 check 这个 a p i' }, fetchImpl)
    expect(result).toMatchObject({
      text: '帮我检查这个 API。',
      polished: true,
      model: 'deepseek-v4.1-flash-1017',
      fallback: false,
    })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/compatible-mode/v1/chat/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-v4.1-flash-1017',
      max_tokens: 1_024,
      enable_thinking: true,
      reasoning_effort: 'high',
    })
  })

  it('falls back to Claude Haiku through the Anthropic API at medium thinking', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('dashscope')) return reply({ error: { message: 'down' } }, 503)
      return reply({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '帮我检查这个 API。' }] })
    }) as unknown as typeof fetch
    const result = await polishTranscript({ text: '帮我 check 这个 a p i' }, fetchImpl, { claudeKey: 'anthropic-test-key' })
    expect(result).toMatchObject({ text: '帮我检查这个 API。', model: 'claude-haiku-5-5', fallback: true })
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>
    expect(calls[1][0]).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({
      model: 'claude-haiku-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    })
  })

  it('falls back to GPT-6 Luna through Codex subscription auth at medium thinking', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('dashscope')) return reply({ error: { message: 'down' } }, 503)
      if (String(url).endsWith('/v1/messages')) return reply({ error: { message: 'down' } }, 503)
      const event = JSON.stringify({
        type: 'response.completed',
        response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '帮我检查这个 API。' }] }] },
      })
      return new Response(`event: response.completed\ndata: ${event}\n\n`, { status: 200 })
    }) as unknown as typeof fetch
    const result = await polishTranscript({ text: '帮我 check 这个 a p i' }, fetchImpl, {
      claudeKey: 'anthropic-test-key',
      codex: { access: 'codex-access-test', accountId: 'account-test', expires: Date.now() + 60_000 },
    })
    expect(result).toMatchObject({ text: '帮我检查这个 API。', model: 'gpt-6-luna', fallback: true })
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>
    expect(calls[2][0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(JSON.parse(String(calls[2][1].body))).toMatchObject({
      model: 'gpt-6-luna',
      stream: true,
      reasoning: { effort: 'medium' },
    })
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
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('PI_CODING_AGENT_DIR', '/nonexistent-pi-agent')
    await expect(polishTranscript({ text: 'hello' })).rejects.toMatchObject({ code: 'asr_polish_unavailable' })
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    const fetchImpl = vi.fn(async () => reply({ error: { message: 'rate limited' } }, 429)) as unknown as typeof fetch
    await expect(polishTranscript({ text: 'hello' }, fetchImpl)).rejects.toMatchObject({
      code: 'asr_polish_all_failed',
      status: 502,
    })
  })
})
