import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SessionAppearanceDialog from '../features/live-sessions/SessionAppearanceDialog'

const open = (props: Partial<React.ComponentProps<typeof SessionAppearanceDialog>> = {}) => {
  const onSave = vi.fn(async () => {})
  const onClose = vi.fn()
  render(<SessionAppearanceDialog title="一个很长的会话名称" onSave={onSave} onClose={onClose} {...props} />)
  return { dialog: screen.getByRole('dialog'), onSave, onClose }
}

describe('SessionAppearanceDialog', () => {
  it('starts with existing appearance and lets custom symbols replace the preset', async () => {
    const { dialog, onSave, onClose } = open({ appearance: { color: '#54937d', emoji: '🌍' } })
    expect(within(dialog).getByRole('button', { name: '绿色标记' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByRole('button', { name: '使用符号 🌍' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(within(dialog).getByLabelText('自定义符号'), { target: { value: '  🐈‍⬛  ' } })
    expect(within(dialog).getByRole('button', { name: '使用符号 🌍' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ color: '#54937d', emoji: '🐈‍⬛' })
  })

  it('keeps keyboard focus inside and handles Escape', () => {
    const { dialog, onClose } = open()
    const close = within(dialog).getByRole('button', { name: '关闭装扮设置' })
    const save = within(dialog).getByRole('button', { name: '保存' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(save).toHaveFocus()
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close or send duplicate writes while a save is pending', async () => {
    let release!: () => void
    const onSave = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const { dialog, onClose } = open({ onSave })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    expect(within(dialog).getByRole('button', { name: '保存中…' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(dialog.parentElement!)
    fireEvent.submit(dialog.querySelector('form')!)
    expect(onClose).not.toHaveBeenCalled()
    expect(onSave).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('shows a write error and retains the draft', async () => {
    const onSave = vi.fn(async () => { throw new Error('请稍后重试') })
    const { dialog, onClose } = open({ onSave })
    fireEvent.click(within(dialog).getByRole('button', { name: '使用符号 🧪' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('请稍后重试')
    expect(within(dialog).getByLabelText('自定义符号')).toHaveValue('🧪')
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeEnabled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
