import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { collectToolStates, groupLiveToolEntries, RunCodeToolCard, TimelineEntry } from '../features/live-sessions/LiveSessionPage'

function call(id = 'run-1', name = 'run_code') {
  return { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { code: 'return await tools.read({path: "/tmp/example.md"})', description: '检查相关文件' } }] } }
}

function start(id: string, name = 'read', args: Record<string, unknown> = { path: '/tmp/example.md' }) {
  return { type: 'tool_execution_start', data: { toolCallId: id, toolName: name, args } }
}

function end(id: string, name = 'read', text = '文件内容', isError = false) {
  return { type: 'tool_execution_end', data: { toolCallId: id, toolName: name, result: { content: [{ type: 'text', text }] }, isError } }
}

function result(id: string, name = 'run_code') {
  return { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: name, content: '汇总完成' } }
}

const entries = [
  call(), start('run-1', 'run_code', call().message.content[0].arguments),
  start('run-1:code:1'),
  start('run-1:code:2', 'bash', { command: 'git status --short' }),
  end('run-1:code:2', 'bash', '工作区有修改'),
  end('run-1:code:1'),
  result('run-1'),
]

function stateFor(data: unknown[] = entries, id = 'run-1') {
  return collectToolStates(data).get(id)!
}

describe('Run Code internal tool ownership', () => {
  it('attaches parallel steps in start order, with their inputs and outputs', () => {
    const state = stateFor()
    expect(state.nestedTools?.map(step => step.toolCallId)).toEqual(['run-1:code:1', 'run-1:code:2'])
    expect(state.nestedTools?.[0]).toMatchObject({ parentToolCallId: 'run-1', argsText: JSON.stringify({ path: '/tmp/example.md' }), executionResult: '文件内容', ended: true })
    expect(state.nestedTools?.[1].executionResult).toBe('工作区有修改')
  })

  it('removes child lifecycle and result rows without removing independent tools', () => {
    const data = [...entries, result('run-1:code:1', 'read'), start('independent', 'bash')]
    const { items } = groupLiveToolEntries(data)
    expect(items.some(item => item.type === 'entry' && item.entry === data.at(-1))).toBe(true)
    expect(items).toHaveLength(2)
    expect(items[0].type).toBe('entry')
    if (items[0].type === 'entry') expect(items[0].entry).toEqual(call())
  })

  it('does not guess ownership when the parent is absent or is another tool', () => {
    for (const data of [[start('missing:code:1')], [call('other', 'bash'), start('other:code:1')]]) {
      const states = collectToolStates(data)
      expect([...states.values()].every(state => !state.parentToolCallId)).toBe(true)
      expect(groupLiveToolEntries(data).items.length).toBeGreaterThan(0)
    }
  })

  it('shows one parent card even when history has no assistant call message', () => {
    const data = [start('run-1', 'run_code'), start('run-1:code:1'), end('run-1:code:1'), end('run-1', 'run_code'), result('run-1')]
    const states = collectToolStates(data)
    const { items } = groupLiveToolEntries(data)
    expect(items).toHaveLength(1)
    if (items[0].type === 'entry') render(<TimelineEntry entry={items[0].entry} onFileOpen={() => {}} toolStates={states} />)
    expect(screen.getAllByRole('article', { name: 'Run Code 及内部步骤' })).toHaveLength(1)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('also renders steps when the only recorded parent entry is its result', () => {
    const data = [start('run-1:code:1'), end('run-1:code:1'), result('run-1')]
    const { items } = groupLiveToolEntries(data)
    expect(items).toHaveLength(1)
    if (items[0].type === 'entry') render(<TimelineEntry entry={items[0].entry} onFileOpen={() => {}} toolStates={collectToolStates(data)} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('does not attach similar but unsupported IDs', () => {
    const states = collectToolStates([call(), start('run-1:read:1'), start('run-1:code:not-a-number')])
    expect(states.get('run-1')?.nestedTools).toBeUndefined()
  })

  it('keeps multiple Run Code calls and their children separate', () => {
    const data = [call('a'), call('b'), start('b:code:1', 'bash'), start('a:code:1')]
    const states = collectToolStates(data)
    expect(states.get('a')?.nestedTools?.map(step => step.toolCallId)).toEqual(['a:code:1'])
    expect(states.get('b')?.nestedTools?.map(step => step.toolCallId)).toEqual(['b:code:1'])
    expect(groupLiveToolEntries(data).items).toHaveLength(2)
  })

  it('keeps batched parent tools in the existing group, without extra child rows', () => {
    const parent = call()
    parent.message.content.push({ type: 'toolCall', id: 'second', name: 'bash', arguments: { code: '', description: '' } })
    const { items } = groupLiveToolEntries([parent, start('run-1:code:1'), result('run-1'), result('second', 'bash')])
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('toolGroup')
    if (items[0].type === 'toolGroup') expect(items[0].items.map(item => item.toolCallId)).toEqual(['run-1', 'second'])
  })
})

describe('Run Code card', () => {
  it('renders the tree through the real timeline entry and hides raw code initially', () => {
    const { items } = groupLiveToolEntries(entries)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('entry')
    if (items[0].type === 'entry') render(<TimelineEntry entry={items[0].entry} onFileOpen={() => {}} toolStates={collectToolStates(entries)} />)
    const card = screen.getByRole('article', { name: 'Run Code 及内部步骤' })
    expect(within(card).getByText('检查相关文件')).toBeTruthy()
    expect(within(card).getAllByRole('listitem')).toHaveLength(2)
    expect(within(card).getByText('2 步')).toBeTruthy()
    expect(card.querySelectorAll('details[open]')).toHaveLength(0)
    expect(within(card).getByRole('button', { name: '收起 Run Code 内部步骤' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('can collapse and reopen the entire step list', () => {
    render(<RunCodeToolCard state={stateFor()} />)
    fireEvent.click(screen.getByRole('button', { name: '收起 Run Code 内部步骤' }))
    expect(screen.queryByRole('list', { name: '内部工具步骤' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开 Run Code 内部步骤' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders a failed step alongside a running step and keeps partial output', () => {
    const data = [call(), start('run-1', 'run_code', call().message.content[0].arguments), start('run-1:code:1'), end('run-1:code:1', 'read', '无法读取文件', true), start('run-1:code:2', 'bash'), { type: 'tool_execution_update', data: { toolCallId: 'run-1:code:2', toolName: 'bash', partialResult: { content: [{ type: 'text', text: '正在搜索' }] } } }]
    render(<RunCodeToolCard state={stateFor(data)} />)
    const steps = screen.getAllByRole('listitem')
    expect(within(steps[0]).getAllByLabelText('失败').length).toBeGreaterThan(0)
    expect(within(steps[1]).getByLabelText('运行中')).toBeTruthy()
    expect(within(steps[0]).getByText('无法读取文件')).toBeTruthy()
    expect(within(steps[1]).getByText('正在搜索')).toBeTruthy()
  })

  it('marks abandoned internal calls as failed rather than running forever', () => {
    render(<RunCodeToolCard state={stateFor([call(), start('run-1:code:1'), { type: 'agent_settled' }])} />)
    expect(within(screen.getByRole('listitem')).getByLabelText('失败')).toBeTruthy()
    expect(screen.queryByLabelText('运行中')).toBeNull()
  })

  it('keeps the parent collapsed while new internal steps arrive', () => {
    const { rerender } = render(<RunCodeToolCard state={stateFor([call(), start('run-1:code:1')])} />)
    fireEvent.click(screen.getByRole('button', { name: '收起 Run Code 内部步骤' }))
    rerender(<RunCodeToolCard state={stateFor()} />)
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('2 步')).toBeTruthy()
  })

  it('updates existing steps as streamed results arrive', () => {
    const { rerender } = render(<RunCodeToolCard state={stateFor([call(), start('run-1:code:1')])} />)
    expect(within(screen.getByRole('listitem')).getByLabelText('运行中')).toBeTruthy()
    rerender(<RunCodeToolCard state={stateFor([call(), start('run-1:code:1'), end('run-1:code:1')])} />)
    expect(within(screen.getByRole('listitem')).getAllByLabelText('成功').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
})
