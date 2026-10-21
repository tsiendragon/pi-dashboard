import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { liveSessionApi } from './api'

type Code = { code: string; expiresAt: number }

/** A deliberately explicit, ephemeral transfer. Never store codes in URLs/storage/logs. */
export default function MobilePairingButton() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState<Code>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const generation = useRef(0)
  const panel = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])
  useEffect(() => {
    if (code && now >= code.expiresAt) {
      setCode(undefined)
      setNotice('配对码已过期，请重新生成。')
    }
  }, [code, now])
  useEffect(() => () => { generation.current++ }, [])

  function close() {
    generation.current++
    setCode(undefined); setError(undefined); setNotice(undefined); setBusy(false); setOpen(false)
    trigger.current?.focus()
  }
  async function generate() {
    const current = ++generation.current
    setBusy(true); setCode(undefined); setError(undefined); setNotice(undefined)
    try {
      const result = await liveSessionApi.pairingCode()
      if (current !== generation.current) return
      if (!result || !/^[a-f0-9]{32}$/.test(result.code) || !Number.isFinite(result.expiresAt)) throw new Error('服务器配对接口响应无效')
      setNow(Date.now()); setCode(result)
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : '生成失败，请确认后端已更新并登录 Live Pi。')
    } finally { if (current === generation.current) setBusy(false) }
  }
  async function copy() {
    if (!code || code.expiresAt <= Date.now()) return
    try {
      await navigator.clipboard.writeText(code.code)
      setNotice('已复制；仅粘贴到你自己的 PiDash App。使用后请清理剪贴板。')
    } catch { setNotice('无法访问剪贴板，请手动复制。') }
  }

  return <>
    <button ref={trigger} type="button" onClick={() => setOpen(true)} className="rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted hover:border-accent hover:text-accent">手机配对</button>
    {open && createPortal(
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (event.key === 'Tab') {
          const targets = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [])
          const first = targets[0], last = targets[targets.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
        <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="手机配对" className="w-full max-w-md rounded-xl border border-border bg-bg-elevated p-5 text-sm text-text shadow-xl">
          <h2 className="mb-3 font-semibold">PiDash 手机配对</h2>
          <p className="mb-3 text-muted">为你自己的手机授权 Live Pi。配对码只可使用一次、最多有效 3 分钟；重新生成会使这个网页之前的码失效。不要分享主机控制 token 或 Cookie。</p>
          <p className="mb-3 text-muted">App 仍需现有的服务器连接凭据。配对不会创建会话或接管正在运行的 Pi；两端拥有独立身份。</p>
          {code && <div className="mb-3 space-y-2">
            <input aria-label="一次性手机配对码" className="w-full rounded border border-border bg-bg p-2 font-mono text-sm" value={code.code} readOnly autoComplete="off" spellCheck={false} />
            <p role="status">约 {Math.max(0, Math.ceil((code.expiresAt - now) / 1000))} 秒后失效（以服务器校验为准）</p>
            <button type="button" onClick={() => void copy()} className="rounded border border-border px-3 py-1">复制配对码</button>
          </div>}
          {error && <p role="alert" className="mb-3 text-danger">{error}</p>}
          {notice && <p role="status" className="mb-3 text-muted">{notice}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className="rounded border border-border px-3 py-2">关闭</button>
            <button type="button" disabled={busy} onClick={() => void generate()} className="rounded bg-accent px-3 py-2 text-accent-fg disabled:opacity-50">{busy ? '生成中…' : '生成一次性配对码'}</button>
          </div>
        </section>
      </div>, document.body,
    )}
  </>
}
