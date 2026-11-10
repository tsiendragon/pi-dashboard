import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import LiveAuditDialog from '../features/live-sessions/LiveAuditDialog'
import type { LiveSessionAuditEntry } from '@shared/live-sessions'

const entry = (overrides: Partial<LiveSessionAuditEntry> = {}): LiveSessionAuditEntry => ({
  at: Date.UTC(2026, 4, 20, 10, 30),
  processInstanceId: 'p',
  action: 'allowed',
  method: 'confirm',
  title: '允许运行：rm -rf build',
  client: 'browser-',
  ...overrides,
})

describe('approval history dialog', () => {
  it('lists decisions newest first with time, method and source', async () => {
    const load = vi.fn().mockResolvedValue([
      entry({ action: 'withdrawn', method: 'queue', title: undefined, detail: '剩余 1 条' }),
      entry({ at: Date.UTC(2026, 4, 20, 9, 0), action: 'denied', title: '删除构建目录' }),
    ])
    render(<LiveAuditDialog processInstanceId="p" onClose={() => {}} load={load} />)
    expect(await screen.findByText('已撤回排队')).toBeInTheDocument()
    expect(screen.getByText('排队消息')).toBeInTheDocument()
    expect(screen.getByText('剩余 1 条')).toBeInTheDocument()
    expect(screen.getByText('已拒绝')).toBeInTheDocument()
    expect(screen.getAllByText(/来源 browser-/)).toHaveLength(2)
    expect(load).toHaveBeenCalledWith('p', 100)
    // The promise of "no password / no argv" is stated where the data is shown.
    expect(screen.getByText(/不会保存密码或 sudo 完整参数/)).toBeInTheDocument()
  })

  it('distinguishes "nothing recorded" from a failed load', async () => {
    const { rerender } = render(<LiveAuditDialog processInstanceId="p" onClose={() => {}} load={vi.fn().mockResolvedValue([])} />)
    expect(await screen.findByText('这一会话还没有需要处理的请求或撤回。')).toBeInTheDocument()
    rerender(<LiveAuditDialog processInstanceId="p" onClose={() => {}} load={vi.fn().mockRejectedValue(new Error('HTTP 500'))} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('读取记录失败：HTTP 500')
  })

  it('closes on Escape and on the close button', async () => {
    const onClose = vi.fn()
    render(<LiveAuditDialog processInstanceId="p" onClose={onClose} load={vi.fn().mockResolvedValue([])} />)
    await waitFor(() => expect(screen.getByRole('dialog', { name: '审批与撤回记录' })).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭记录' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})