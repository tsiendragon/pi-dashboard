import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { collectToolStates, groupLiveToolEntries, TimelineEntry } from '../features/live-sessions/LiveSessionPage'

describe('single proof tool result visibility', () => {
  it.each([
    ['proof_solve', false], ['proof_solve_status', false],
    ['proof_solve', true], ['proof_solve_status', true],
  ] as const)('renders %s after its result arrives (streamed=%s)', (name, streamed) => {
    const payload = JSON.stringify({ execution_status:'awaiting_alignment', target_status:'open', certificate:{verdict:'VERIFIED'}, audit_status:'not_run' })
    const callMessage = {role:'assistant', content:[{type:'toolCall', id:'proof-call', name, arguments: name === 'proof_solve' ? {claim:'T'} : {run:'s-test'}}]}
    const resultMessage = {role:'toolResult', toolCallId:'proof-call', toolName:name, content:[{type:'text',text:payload}]}
    const entries = streamed ? [
      {type:'message_end',data:{message:callMessage}},
      {type:'tool_execution_end',data:{toolCallId:'proof-call',toolName:name,result:{content:[{type:'text',text:payload}]},isError:false}},
      {type:'message_end',data:{message:resultMessage}},
    ] : [
      {type:'message',id:'assistant-proof',message:callMessage},
      {type:'message',message:resultMessage},
    ]
    const {items} = groupLiveToolEntries(entries, true)
    const {container} = render(<>{items.map((item,index) => item.type === 'entry'
      ? <TimelineEntry key={index} entry={item.entry} onFileOpen={() => {}} toolStates={collectToolStates(entries)} auxiliary />
      : null)}</>)
    // Generic Live tools use a native details card, not ChatPage ToolCallBlock;
    // both now expose the same stable data-pidash-tool-* hooks.
    const cards = container.querySelectorAll(`[data-pidash-tool-name="${name}"]`)
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute('data-pidash-tool-status')).toBe('ok')
    expect(cards[0].querySelectorAll('details')).toHaveLength(1)
    const toggle = cards[0].querySelector('summary')!
    expect(toggle.querySelector('[aria-label="成功"]')).toBeTruthy()
    fireEvent.click(toggle)
    expect((cards[0].querySelector('details') as HTMLDetailsElement).open).toBe(true)
    expect(screen.getByText(/awaiting_alignment/)).toBeTruthy()
    expect(screen.getByText(/VERIFIED/)).toBeTruthy()
    expect(screen.getByText(/"target_status"\s*:\s*"open"/)).toBeTruthy()
    expect(screen.queryByText(/target_status.*proved/)).toBeNull()
  })
})
