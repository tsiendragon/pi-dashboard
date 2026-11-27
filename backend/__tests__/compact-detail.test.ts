import { describe, expect, it } from 'vitest'
import { compactDetail, compactBrowserMessage, compactEvent } from '../live-sessions/compact.js'

const full = {
  summary: { processInstanceId: 'p', sessionId: 's' },
  entries: [
    { type: 'message', id: 'm1', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'cat secret.txt' } },
      { type: 'text', text: 'final answer' },
    ] } },
    { type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'secret output' }] } },
    { type: 'tool_execution_end', data: { toolCallId: 'call-1', toolName: 'bash', args: { command: 'cat secret.txt' }, result: { content: [{ type: 'text', text: 'secret output' }] }, isError: false } },
  ],
}

describe('compact live detail', () => {
  it('keeps final prose and tool status but redacts thinking, arguments and output', () => {
    const compact = compactDetail(full) as typeof full & { compact?: boolean; entries: any[] }
    expect(compact.compact).toBe(true)
    const message = compact.entries[0]
    expect(message.message.content).toEqual([
      { type: 'thinking', thinking: '' },
      { type: 'toolCall', id: 'call-1', name: 'bash', piArgsOmitted: true },
      { type: 'text', text: 'final answer' },
    ])
    expect(message.piOmitted).toMatchObject({ thinking: true, args: true })
    expect(message.message.content[1].arguments).toBeUndefined()
    expect(compact.entries[1].piOmitted).toMatchObject({ output: true })
    expect(compact.entries[2].piOmitted).toMatchObject({ args: true, output: true })
    expect(JSON.stringify(compact)).not.toContain('secret reasoning')
    expect(JSON.stringify(compact)).not.toContain('secret output')
    expect(JSON.stringify(compact)).not.toContain('secret.txt')
    // Full registry data is not mutated.
    expect(full.entries[0].message.content[0].thinking).toBe('secret reasoning')
  })

  it('compacts streamed tool events and snapshot messages', () => {
    const event = compactBrowserMessage({
      type: 'live_session_event',
      data: {
        processInstanceId: 'p',
        event: { type: 'tool_execution_end', data: { toolCallId: 'call-1', args: { command: 'cat secret.txt' }, result: { content: [{ type: 'text', text: 'secret output' }] } } },
      },
    }) as any
    expect(event.data.event.piOmitted).toMatchObject({ args: true, output: true })
    expect(JSON.stringify(event)).not.toContain('secret')
    expect(compactEvent({ type: 'message_end', data: { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'answer' }] } } }))
      .toMatchObject({ piOmitted: { thinking: true } })
  })
})
