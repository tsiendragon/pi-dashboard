import { describe, expect, it } from 'vitest'
import type { LiveSessionDetail } from '../../shared/src/live-sessions.js'
import { digestSession, sentences } from '../supervisor/digest.js'

function detail(messages: Array<string | { role: 'user' | 'assistant'; text: string }>): LiveSessionDetail {
  return {
    summary: { status: 'idle', lastActivityAt: Date.now() },
    entries: messages.map(entry => {
      const value = typeof entry === 'string' ? { role: 'assistant' as const, text: entry } : entry
      return { message: { role: value.role, content: value.text } }
    }),
  } as unknown as LiveSessionDetail
}

describe('session digest', () => {
  it('keeps the newest result as headline and readable points, dropping commands, paths and code', () => {
    const digest = digestSession(detail([
      '喵，先跑一段：\n```bash\nnpm test -- --run\n```\n/home/user/repos/x/a.ts 这个文件路径不应出现。',
      '喵，回答你的问题：预览页已加上示例，刷新即可看到效果。',
      '喵，这个任务的结果我已经读过了：exit=0，3 个测试文件 23 项全部通过，和刚才汇报的一致。',
    ]))
    expect(digest?.source).toBe('recent_output')
    expect(digest?.coveredMessages).toBe(3)
    expect(digest?.headline).toBe('这个任务的结果我已经读过了：exit=0，3 个测试文件 23 项全部通过，和刚才汇报的一致。')
    expect(digest?.points).toEqual(['回答你的问题：预览页已加上示例，刷新即可看到效果。'])
    expect(JSON.stringify(digest)).not.toContain('npm test')
    expect(JSON.stringify(digest)).not.toContain('/home/user/repos')
  })

  it('reports an open question and a follow-up separately, and never repeats them as points', () => {
    const digest = digestSession(detail([
      { role: 'assistant', text: '喵，第一阶段已经完成，改动落在活动时间线组件里。' },
      { role: 'user', text: '要不要继续修改？' },
      { role: 'assistant', text: '喵，需要你确认：是否保留右上角入口？下一步会先跑前端类型检查，再更新文档。' },
    ]))
    expect(digest?.waitingFor).toContain('需要你确认')
    expect(digest?.nextStep).toContain('下一步会先跑前端类型检查')
    expect(digest?.points).not.toContain(digest?.waitingFor)
    expect(digest?.points).not.toContain(digest?.nextStep)
  })

  it('does not turn a denial into an open wait, limit points and stay undefined without assistant text', () => {
    const denied = digestSession(detail(['当前没有待处理的后续：状态停在等用户确认效果，确认后再由你执行 ./run.sh。']))
    expect(denied?.waitingFor).toBeUndefined()
    expect(denied?.nextStep).toBeUndefined()
    const many = digestSession(detail(['第一条要点说明了范围。第二条要点说明了结论。第三条要点说明了风险。第四条要点说明了后续。']))
    expect((many?.points.length || 0) <= 3).toBe(true)
    const nearDuplicate = digestSession(detail(['报告已同步到最新版本，覆盖全部结论与缺口，可以据此复核。', '报告已同步到最新版本，覆盖全部结论与缺口，可以据此复核直到结束。']))
    expect(nearDuplicate?.points.length).toBeLessThanOrEqual(1)
    expect(digestSession(detail([{ role: 'user', text: '你好' }]))).toBeUndefined()
    expect(digestSession({ summary: { status: 'idle' }, entries: [] } as unknown as LiveSessionDetail)).toBeUndefined()
  })

  it('splits sentences on Chinese punctuation and strips spoken lead-ins and markdown', () => {
    expect(sentences('喵，**结论**：已经修复。\n1. 之后跑测试；\n- [报告](http://x/y) 已更新。')).toEqual(['结论：已经修复。', '之后跑测试；', '报告 已更新。'])
  })
})