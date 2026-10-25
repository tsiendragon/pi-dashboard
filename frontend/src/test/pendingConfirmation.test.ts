import { describe, expect, it } from 'vitest'
import type { LiveSessionSummary, LiveSessionUiRequest } from '@shared/live-sessions'
import { collectPendingConfirmations, hasConfirmationMarker, splitConfirmationMarker } from '../features/supervisor/pendingConfirmation'

function request(over: Partial<LiveSessionUiRequest> = {}): LiveSessionUiRequest {
  return { id: 'ui-1', method: 'confirm', title: '主 Agent 操作确认', ...over }
}

function session(processInstanceId: string, pid: number, name?: string): LiveSessionSummary {
  return {
    processInstanceId, sessionId: `s-${processInstanceId}`, pid,
    cwd: '~/repos/app', canonicalCwd: '~/repos/app',
    ...(name ? { sessionName: name } : {}),
    mode: 'tui', status: 'idle', claim: { state: 'unclaimed' },
    startedAt: pid, lastActivityAt: pid, revision: 1, eventSequence: 0,
  }
}

const MESSAGE = [
  '当前消息未明确授权这项操作，请核对目标与内容：',
  '{"operation":"record"}',
  '',
  '也可以直接在对话里回复「确认」来允许这次操作。',
  '[supervisor-confirm]{"op":"record","ref":"task-journal:eu-fake-id-service","sum":"记录 EU Fake-ID 项目起点"}',
].join('\n')

describe('pending confirmation trailer', () => {
  it('splits the machine trailer from the text shown to the user', () => {
    const { marker, body } = splitConfirmationMarker(MESSAGE)
    expect(marker).toEqual({ op: 'record', ref: 'task-journal:eu-fake-id-service', sum: '记录 EU Fake-ID 项目起点' })
    expect(body).not.toContain('[supervisor-confirm]')
    expect(body).toContain('当前消息未明确授权这项操作')
  })

  it('leaves requests without a trailer for the modal fallback', () => {
    expect(hasConfirmationMarker(request({ message: 'goal 想确认一件事' }))).toBe(false)
    expect(hasConfirmationMarker(request({ message: MESSAGE }))).toBe(true)
    expect(splitConfirmationMarker(undefined)).toEqual({ body: '' })
  })

  it('collects only targeted requests and narrows them to one object', () => {
    const pendingUi = {
      'process-main': {
        'ui-1': request({ id: 'ui-1', message: MESSAGE }),
        'ui-2': request({ id: 'ui-2', message: '没有标记的确认' }),
      },
      'process-other': {
        'ui-3': request({ id: 'ui-3', message: '[supervisor-confirm]{"op":"task_update","ref":"local:t-2","sum":"把任务标成完成"}' }),
      },
    }
    const sessions = { 'process-main': session('process-main', 101, '主会话'), 'process-other': session('process-other', 202) }

    const all = collectPendingConfirmations(pendingUi, sessions)
    expect(all.map(item => item.request.id).sort()).toEqual(['ui-1', 'ui-3'])
    const byId = new Map(all.map(item => [item.request.id, item]))
    expect(byId.get('ui-1')?.sessionLabel).toBe('主会话')
    expect(byId.get('ui-1')?.summary).toBe('记录 EU Fake-ID 项目起点')

    const scoped = collectPendingConfirmations(pendingUi, sessions, 'task-journal:eu-fake-id-service')
    expect(scoped.map(item => item.request.id)).toEqual(['ui-1'])
    expect(collectPendingConfirmations(pendingUi, sessions, 'local:t-9')).toEqual([])
  })

  it('survives a malformed trailer without hiding the request text', () => {
    const { marker, body } = splitConfirmationMarker('正文\n[supervisor-confirm]{oops')
    expect(marker).toBeUndefined()
    expect(body).toContain('正文')
  })
})