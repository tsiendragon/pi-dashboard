import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkbenchPanel from '../features/workbench/WorkbenchPanel'

let integration: { attached: boolean; pending: number; error: undefined; snapshot: Record<string, unknown>; send: ReturnType<typeof vi.fn> }
vi.mock('../features/useIntegration', () => ({ useIntegration: () => integration }))
vi.mock('../store', () => ({ useAppSelector: (selector: (state: unknown) => unknown) => selector({ dashboard: { slots: [{ key: 'slot-a', cwd: '/tmp', model: 'azure-gateway/gpt-6.1-sol' }] } }) }))
vi.mock('../pages/chat/ToolCallBlock', () => ({ default: () => <div>工具记录</div> }))
vi.mock('../pages/chat/ThinkingBlock', () => ({ default: () => <div>思考记录</div> }))

const conversation = (id = 'agent-1') => ({ id, label: `任务 ${id}`, status: 'idle', latestRunStatus: 'completed', availability: 'available', resultPreview: '结果正文', updatedAt: 1 })
const snapshot = (items: unknown[] = []) => ({ revision: 1, conversations: { items }, workflows: { items: [] } })
beforeEach(() => { integration = { attached: true, pending: 0, error: undefined, snapshot: snapshot(), send: vi.fn().mockResolvedValue({}) } })

describe('workbench lifecycle', () => {
  it('folds twenty completed idle conversations and does not classify them as active', () => {
    integration.snapshot = snapshot(Array.from({ length: 20 }, (_, i) => conversation(`agent-${i}`)))
    const { container } = render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    expect(screen.getByText('已完成 · 20')).toBeInTheDocument()
    expect(container.querySelector('details')?.open).toBe(false)
    expect(screen.queryByText('运行中 · 20')).toBeNull()
  })

  it('keeps selected results when a record disappears and disables stale follow-up', () => {
    integration.snapshot = snapshot([conversation()])
    const { rerender } = render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    fireEvent.click(screen.getByText('任务 agent-1'))
    expect(screen.getByText('结果正文')).toBeInTheDocument()
    integration.snapshot = snapshot()
    rerender(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    expect(screen.getByText('结果正文')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByLabelText('继续追问')).toBeDisabled()
  })

  it('does not close selected detail on bridge disconnection', () => {
    integration.snapshot = snapshot([conversation()])
    const { rerender } = render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    fireEvent.click(screen.getByText('任务 agent-1'))
    integration.attached = false
    rerender(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    expect(screen.getByText('结果正文')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('does not implicitly send the expensive parent model to start-agent', async () => {
    render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('子助手任务'), { target: { value: '检查指定文件' } })
    fireEvent.click(screen.getByRole('button', { name: '开始子任务' }))
    expect(integration.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'start-agent', task: '检查指定文件', cwd: '/tmp' }))
    expect(integration.send.mock.calls[0][0]).not.toHaveProperty('model')
  })

  it('allows exact explicit model and rejects fuzzy model before sending', () => {
    render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('子助手任务'), { target: { value: '检查文件' } })
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: 'luna' } })
    fireEvent.click(screen.getByRole('button', { name: '开始子任务' }))
    expect(integration.send).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('provider/model')
    fireEvent.change(screen.getByLabelText('执行模型'), { target: { value: 'azure-gateway/gpt-5.6-luna' } })
    fireEvent.click(screen.getByRole('button', { name: '开始子任务' }))
    expect(integration.send).toHaveBeenCalledWith(expect.objectContaining({ model: 'azure-gateway/gpt-5.6-luna' }))
  })

  it('shows offline workflow task output without a sessionId and omits the parent model on workflow creation', () => {
    integration.snapshot = { ...snapshot(), workflows: { items: [{ id: 'workflow-1', label: '检查工作流', status: 'completed', stages: [{ id: 'stage-1', label: '第一阶段', status: 'completed', tasks: [{ id: 'task-1', label: '离线任务', status: 'completed', output: '离线检查结果' }] }] }] } }
    render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '工作流 · 1' }))
    fireEvent.click(screen.getByText('检查工作流'))
    fireEvent.click(screen.getByText('离线任务 · 已完成'))
    expect(screen.getByText('离线检查结果')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('工作流任务'), { target: { value: '查代码\n检查风险' } })
    fireEvent.click(screen.getByRole('button', { name: '开始工作流' }))
    expect(integration.send.mock.calls[0][0]).toMatchObject({ type: 'start-workflow', stages: [{ label: '阶段 1', tasks: [{ task: '查代码', cwd: '/tmp' }, { task: '检查风险', cwd: '/tmp' }] }] })
    expect(integration.send.mock.calls[0][0]).not.toHaveProperty('model')
  })

  it('keeps failed/unknown records visible and workflow children out of ordinary list', () => {
    integration.snapshot = snapshot([{ ...conversation('failed'), latestRunStatus: 'failed', error: '检查失败' }, { ...conversation('unknown'), latestRunStatus: undefined }, { ...conversation('child'), workflowId: 'wf' }])
    render(<WorkbenchPanel slot="slot-a" onClose={() => {}} />)
    expect(screen.getByText('需要处理或确认 · 2')).toBeInTheDocument()
    expect(screen.queryByText('任务 child')).toBeNull()
    fireEvent.click(screen.getByText('任务 failed'))
    expect(screen.getByRole('alert')).toHaveTextContent('检查失败')
  })
})
