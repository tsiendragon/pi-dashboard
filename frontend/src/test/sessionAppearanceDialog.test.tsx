import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SessionAppearanceDialog from '../features/live-sessions/SessionAppearanceDialog'
import { SESSION_COLORS, SESSION_EMOJI_GROUPS } from '../features/live-sessions/sessionAppearanceOptions'

const open = (props: Partial<React.ComponentProps<typeof SessionAppearanceDialog>> = {}) => {
  const onSave = vi.fn(async () => {})
  const onClose = vi.fn()
  render(<SessionAppearanceDialog title="一个很长的会话名称" onSave={onSave} onClose={onClose} {...props} />)
  return { dialog: screen.getByRole('dialog'), onSave, onClose }
}

describe('SessionAppearanceDialog', () => {
  it('keeps every quick pick within the existing storage limits', () => {
    expect(SESSION_COLORS.filter(option => option.value)).toHaveLength(18)
    expect(new Set(SESSION_COLORS.map(option => option.value)).size).toBe(SESSION_COLORS.length)
    SESSION_COLORS.filter(option => option.value).forEach(option => expect(option.value).toMatch(/^#[0-9a-f]{6}$/))
    expect(Object.keys(SESSION_EMOJI_GROUPS)).toHaveLength(8)
    const symbols = Object.values(SESSION_EMOJI_GROUPS).flat()
    expect(symbols.length).toBeGreaterThanOrEqual(190)
    for (const group of Object.values(SESSION_EMOJI_GROUPS)) {
      expect(new Set(group).size).toBe(group.length)
      group.forEach(symbol => {
        expect(symbol).not.toBe('')
        expect(symbol.length).toBeLessThanOrEqual(24)
        expect(symbol).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u)
      })
    }
  })

  it.each(Object.entries(SESSION_EMOJI_GROUPS))('can choose and save a symbol from %s', async (group, symbols) => {
    const { dialog, onSave, onClose } = open()
    const symbol = symbols[symbols.length - 1]
    fireEvent.change(within(dialog).getByLabelText('表情分类'), { target: { value: group } })
    fireEvent.click(within(dialog).getByRole('button', { name: `使用符号 ${symbol}` }))
    expect(within(dialog).getByLabelText('装扮预览')).toHaveTextContent(symbol)
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ color: '', emoji: symbol })
  })

  it('retains the chosen symbol when browsing a different category', () => {
    const { dialog } = open({ appearance: { emoji: '🤖' } })
    fireEvent.change(within(dialog).getByLabelText('表情分类'), { target: { value: '动物与自然' } })
    expect(within(dialog).getByLabelText('自定义符号')).toHaveValue('🤖')
    expect(within(dialog).getByLabelText('装扮预览')).toHaveTextContent('🤖')
    fireEvent.click(within(dialog).getByRole('button', { name: '使用符号 🐼' }))
    expect(within(dialog).getByLabelText('自定义符号')).toHaveValue('🐼')
  })

  it('loads and saves arbitrary custom colors, with reset returning to default', async () => {
    const { dialog, onSave, onClose } = open({ appearance: { color: '#123abc', emoji: '👍🏽' } })
    const picker = within(dialog).getByLabelText('自定义标记颜色')
    expect(picker).toHaveValue('#123abc')
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复默认' }))
    expect(within(dialog).getByRole('button', { name: '默认标记' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByLabelText('自定义符号')).toHaveValue('')
    fireEvent.change(picker, { target: { value: '#12ab34' } })
    expect(within(dialog).getByLabelText('装扮预览').querySelector('[style]')).toHaveStyle({ backgroundColor: '#12ab34' })
    fireEvent.click(within(dialog).getByRole('button', { name: '红色标记' }))
    expect(picker).toHaveValue('#c65b5b')
    fireEvent.change(picker, { target: { value: '#12ab34' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ color: '#12ab34', emoji: '' })
  })

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
    expect(within(dialog).getByLabelText('表情分类')).toBeDisabled()
    expect(within(dialog).getByLabelText('自定义标记颜色')).toBeDisabled()
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
