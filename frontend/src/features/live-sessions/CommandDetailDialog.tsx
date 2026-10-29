import { useEffect, useState } from 'react'

/**
 * 一条命令的详情：底部命令 chip 和活动视图里的命令 chip 共用同一个弹层，
 * 免得两处各写一份样式，字段和「转到后台」的操作慢慢走偏。
 */
export interface CommandDetail {
  /** 状态徽标：文案 + 现有配色 class（例如 `bg-ok-subtle text-ok`）。 */
  tag: { text: string; className: string }
  /** 标题栏右侧的说明，例如「运行回归测试 · 前台命令」。 */
  title: string
  command: string
  cwd?: string
  /** 时间项目的名字：「已运行」还是「耗时」。 */
  timeLabel?: string
  time?: string
  exitCode?: number | string
  error?: string
  output?: string
  running: boolean
  /** 提供才显示「转到后台」；没有就是纯查看。 */
  onMoveToBackground?: () => Promise<void> | void
}

export default function CommandDetailDialog({ detail, onClose }: { detail: CommandDetail; onClose: () => void }) {
  const [moving, setMoving] = useState(false)
  const [moved, setMoved] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const canMove = Boolean(detail.onMoveToBackground) && detail.running && !moved
  const move = async () => {
    if (!detail.onMoveToBackground) return
    setMoving(true)
    try {
      await detail.onMoveToBackground()
      setMoved(true)
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4" role="presentation" onClick={onClose}>
      <section className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl" role="dialog" aria-modal="true" aria-label="命令详情" onClick={event => event.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2">
          <span className={`shrink-0 rounded px-1.5 text-2xs ${detail.tag.className}`}>{detail.tag.text}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-strong">{detail.title}</span>
          <button type="button" onClick={onClose} className="shrink-0 rounded border border-border bg-bg px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent">关闭</button>
        </header>
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
          <dt className="text-muted">命令</dt><dd className="m-0 whitespace-pre-wrap break-all font-mono text-text">{detail.command}</dd>
          {detail.cwd && <><dt className="text-muted">目录</dt><dd className="m-0 break-all font-mono text-text">{detail.cwd}</dd></>}
          {detail.time && <><dt className="text-muted">{detail.timeLabel || (detail.running ? '已运行' : '耗时')}</dt><dd className="m-0 text-text">{detail.time}</dd></>}
          {detail.exitCode !== undefined && <><dt className="text-muted">退出码</dt><dd className="m-0 text-text">{detail.exitCode}</dd></>}
          {detail.error && <><dt className="text-muted">错误</dt><dd className="m-0 whitespace-pre-wrap break-all text-danger">{detail.error}</dd></>}
        </dl>
        <pre className="m-0 min-h-24 flex-1 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-bg p-3 font-mono text-xs leading-5 text-text">{detail.output || (detail.running ? '等待输出…' : '（无输出）')}</pre>
        {(canMove || moved) && <footer className="flex items-center gap-3 border-t border-border px-3 py-2">
          <span className="min-w-0 flex-1 text-2xs text-muted">{moved ? '已转到后台，命令继续运行；右侧「后台命令」里能看到它。' : '转到后台后命令继续运行、不重启，Pi 不再等它，可以接着做别的；结束时会通知 Pi。'}</span>
          <button type="button" disabled={moving || moved} onClick={() => { void move() }} className="shrink-0 rounded border border-accent bg-accent px-3 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50">{moved ? '已转到后台' : moving ? '转移中…' : '转到后台'}</button>
        </footer>}
      </section>
    </div>
  )
}