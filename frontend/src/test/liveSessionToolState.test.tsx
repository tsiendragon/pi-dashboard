import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  buildLiveActivityEvidence,
  collectToolStates,
  deriveAgentState,
  TimelineEntry,
} from '../features/live-sessions/LiveSessionPage'

const readCall = {
  type: 'message_end',
  data: {
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'read-call-1', name: 'read', arguments: { path: '/tmp/report.md' } }],
    },
  },
}
const readStart = { type: 'tool_execution_start', data: { toolCallId: 'read-call-1', toolName: 'read' } }

function entriesAfter(terminalType: 'compaction_end' | 'agent_settled') {
  return [readCall, readStart, { type: terminalType }]
}

describe('live-session stale tool states', () => {
  it.each(['compaction_end', 'agent_settled'] as const)('stops a missing-result read at %s', terminalType => {
    const entries = entriesAfter(terminalType)
    const states = collectToolStates(entries)

    expect(states.get('read-call-1')).toMatchObject({ started: true, ended: false, abandoned: true })
    expect(deriveAgentState('running', entries, states).activeTools).toEqual([])
    expect(buildLiveActivityEvidence(entries)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'read-call-1', status: 'error' }),
    ]))
  })

  it('renders the read as failed, not running, after compaction ends without a result', () => {
    const entries = entriesAfter('compaction_end')
    const toolStates = collectToolStates(entries)
    const { container } = render(
      <TimelineEntry entry={readCall} onFileOpen={() => {}} toolStates={toolStates} />,
    )

    expect(container.querySelector('[aria-label="失败"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="运行中"]')).toBeNull()
  })

  it('names the compaction instead of pretending a turn is running', () => {
    // pi reports a compaction as “not idle”, exactly like a running turn; the
    // bridge's marker is what tells the two apart.
    expect(deriveAgentState('running', [], new Map(), true)).toMatchObject({ label: '压缩上下文', tone: 'accent', activeTools: [] })
    expect(deriveAgentState('idle', [], new Map(), false).label).toBe('等待输入')
  })
})
