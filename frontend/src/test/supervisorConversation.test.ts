import { describe, expect, it } from 'vitest'
import { conversationMessages } from '../features/supervisor/conversation'

const message = (role: string, text: string) => ({ type: 'message', message: { role, content: [{ type: 'text', text }] } })

describe('主管对话的读取视图', () => {
  it('keeps the exchange and leaves tool output out of it', () => {
    const transcript = conversationMessages([
      { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '请检查任务' }] } },
      { ...message('assistant', '我看一下'), id: 'm2' },
      { type: 'message', id: 'm3', message: { role: 'toolResult', toolName: 'task-journal', content: [{ type: 'text', text: JSON.stringify({ tasks: ['一页 JSON'] }) }] } },
      { ...message('assistant', '检查完了'), id: 'm4' },
    ])

    expect(transcript.messages.map(item => item.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(transcript.messages.map(item => item.text)).toEqual(['请检查任务', '我看一下', '检查完了'])
    expect(transcript.omittedToolResults).toBe(1)
  })

  it('deduplicates a message that arrives both as an event and as a snapshot', () => {
    const transcript = conversationMessages([
      { type: 'message_end', data: { entryId: 'entry-1', message: { role: 'assistant', content: [{ type: 'text', text: '旧' }] } } },
      { type: 'message', id: 'entry-1', message: { role: 'assistant', content: [{ type: 'text', text: '新' }] } },
    ])

    expect(transcript.messages).toHaveLength(1)
    expect(transcript.messages[0].text).toBe('新')
  })

  it('counts one omitted result once, even when it arrives twice', () => {
    const transcript = conversationMessages([
      { type: 'message_end', data: { entryId: 'tr-1', message: { role: 'toolResult', content: [{ type: 'text', text: '终端输出' }] } } },
      { type: 'message', id: 'tr-1', message: { role: 'toolResult', content: [{ type: 'text', text: '终端输出' }] } },
    ])

    expect(transcript.messages).toHaveLength(0)
    expect(transcript.omittedToolResults).toBe(1)
  })
})