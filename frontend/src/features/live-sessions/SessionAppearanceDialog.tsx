import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LiveSessionMeta } from '@shared/live-sessions'
import MaterialIcon from '../../components/MaterialIcon'
import { SESSION_COLORS, SESSION_EMOJI_GROUPS } from './sessionAppearanceOptions'
export type SessionAppearance = Required<Pick<LiveSessionMeta, 'color' | 'emoji'>>

interface Props {
  title: string
  appearance?: Pick<LiveSessionMeta, 'color' | 'emoji'>
  onSave: (appearance: SessionAppearance) => Promise<void>
  onClose: () => void
}

export default function SessionAppearanceDialog({ title, appearance, onSave, onClose }: Props) {
  const [color, setColor] = useState(appearance?.color ?? '')
  const [emoji, setEmoji] = useState(appearance?.emoji ?? '')
  const [emojiGroup, setEmojiGroup] = useState<keyof typeof SESSION_EMOJI_GROUPS>('常用')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const headingId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const savingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!savingRef.current) onCloseRef.current()
      }
      if (event.key === 'Tab') {
        const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>('button, input, select') ?? [])]
          .filter(control => !control.matches(':disabled'))
        if (!controls?.length) {
          event.preventDefault()
          panelRef.current?.focus()
          return
        }
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current?.contains(document.activeElement))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const save = async () => {
    if (savingRef.current) return
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(emoji)) {
      setError('符号不能包含换行或控制字符。')
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await onSave({ color, emoji: emoji.trim() })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-4"
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget && !savingRef.current) onClose() }}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId} aria-busy={saving} className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-xl border border-border bg-card text-text shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-5 py-4">
          <h2 id={headingId} className="text-sm font-semibold">设置会话装扮</h2>
          <button ref={closeRef} type="button" disabled={saving} aria-label="关闭装扮设置" onClick={onClose} className="rounded p-1 text-muted hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"><MaterialIcon name="close" className="h-4 w-4" /></button>
        </div>
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          <fieldset disabled={saving} className="min-w-0 space-y-4 px-5 py-4 disabled:opacity-60">
            <p className="break-words text-xs text-muted" title={title}>{title}</p>
            <fieldset className="min-w-0">
              <legend className="mb-2 text-xs font-medium">标记颜色</legend>
              <div className="flex flex-wrap gap-2.5">
                {SESSION_COLORS.map(option => <button key={option.value} type="button" aria-label={`${option.label}标记`} aria-pressed={color === option.value} title={option.label} onClick={() => setColor(option.value)} style={{ backgroundColor: option.value || undefined }} className={`flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${color === option.value ? 'ring-2 ring-accent ring-offset-2 ring-offset-card' : ''}`}>
                  {!option.value && <span aria-hidden="true">∅</span>}
                </button>)}
              </div>
              <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">自定义颜色
                <input type="color" aria-label="自定义标记颜色" value={color || '#5287be'} onChange={event => setColor(event.target.value)} className="h-8 w-10 cursor-pointer rounded border border-border bg-bg p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
                <span className="font-mono text-2xs">{color || '默认'}</span>
              </label>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-2 text-xs font-medium">会话符号</legend>
              <label className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">表情分类
                <select value={emojiGroup} onChange={event => setEmojiGroup(event.target.value as keyof typeof SESSION_EMOJI_GROUPS)} className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                  {Object.keys(SESSION_EMOJI_GROUPS).map(group => <option key={group} value={group}>{group}</option>)}
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                {['', ...SESSION_EMOJI_GROUPS[emojiGroup]].map(symbol => <button key={symbol} type="button" aria-label={symbol ? `使用符号 ${symbol}` : '不设置符号'} aria-pressed={emoji === symbol} onClick={() => setEmoji(symbol)} className={`flex h-9 w-9 items-center justify-center rounded-md border border-border text-lg hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${emoji === symbol ? 'ring-2 ring-accent' : ''}`}>{symbol || '∅'}</button>)}
              </div>
              <label className="mt-3 flex items-center gap-3 text-xs text-muted">自定义符号
                <input value={emoji} onChange={event => setEmoji(event.target.value)} maxLength={24} placeholder="输入或粘贴，如 🐱" className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
              </label>
              <p className="mt-2 text-2xs text-muted">也可用 iPhone 表情键盘输入或粘贴；显示样式随设备和系统版本而变。</p>
            </fieldset>
            <div aria-label="装扮预览" className="relative flex min-w-0 items-center gap-2 overflow-hidden rounded-md border border-border bg-bg py-3 pl-4 pr-3">
              {color && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-[3px] rounded-r" style={{ backgroundColor: color }} />}
              <span aria-label="运行状态不变" className="shrink-0 text-muted">○</span>
              {emoji.trim() && <span data-session-emoji className="max-w-16 shrink-0 truncate text-meta leading-none">{emoji.trim()}</span>}
              <span className="min-w-0 truncate text-sm">{title}</span>
            </div>
            <p id={descriptionId} className="text-2xs text-muted">仅改变外观，不影响运行状态、分组或标签。此设置保存在当前 Dashboard，其他连接它的浏览器也会看到。</p>
          </fieldset>
          {error && <p role="alert" className="px-5 pb-3 text-xs text-danger">{error}</p>}
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-card px-5 py-3 text-xs">
            <button type="button" disabled={saving} onClick={() => { setColor(''); setEmoji(''); setError('') }} className="rounded-md border border-border px-2.5 py-1.5 hover:bg-bg-hover disabled:opacity-40">恢复默认</button>
            <button type="button" disabled={saving} onClick={onClose} className="ml-auto rounded-md border border-border px-2.5 py-1.5 hover:bg-bg-hover disabled:opacity-40">取消</button>
            <button type="submit" disabled={saving} className="rounded-md bg-accent px-3 py-1.5 text-accent-fg disabled:opacity-40">{saving ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
