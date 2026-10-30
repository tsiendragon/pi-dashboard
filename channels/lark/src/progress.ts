/**
 * Live progress card for a chat-originated agent run.
 *
 * Without it the chat stays silent from "message sent" until the whole answer is
 * done — minutes for a long task, which reads as "the bot did not get it". When
 * the chat sends input, a card goes out immediately (⏳ 思考中), is patched in
 * place as tools run, and finally becomes the answer card itself.
 */

import { buttonRow, card, escapeMarkdown, inline, md, type CardElement, type LarkCard } from './cards.js'

export interface ProgressStep {
  tool: string
  detail: string
  state: 'running' | 'done' | 'error'
  toolCallId?: string
}

/** Steps shown while running; older ones collapse into a counter. */
const VISIBLE_STEPS = 6

/** `bash {command: "ls -la"}` -> `ls -la`; best-effort, never throws. */
export function describeTool(toolName: string, args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    return ''
  }
  const raw =
    pick('command', 'cmd') ||
    pick('path', 'file_path', 'filePath', 'file') ||
    pick('query', 'pattern', 'url', 'prompt', 'task', 'description', 'title') ||
    ''
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
}

function stepLine(step: ProgressStep): string {
  const icon = step.state === 'running' ? '⏳' : step.state === 'error' ? '❌' : '✅'
  return `${icon} **${inline(step.tool)}**${step.detail ? ` \`${step.detail.replace(/`/g, "'")}\`` : ''}`
}

/** The card while the agent works. */
export function progressCard(title: string, steps: ProgressStep[], elapsedMs: number, phase: 'thinking' | 'working'): LarkCard {
  const hidden = Math.max(0, steps.length - VISIBLE_STEPS)
  const lines = [
    ...(hidden ? [`<font color='grey'>… 另有 ${hidden} 步已完成</font>`] : []),
    ...steps.slice(-VISIBLE_STEPS).map(stepLine),
  ]
  const status = phase === 'thinking' && steps.length === 0 ? '⏳ 思考中…' : `⚙️ 执行中 · 第 ${steps.length} 步`
  return card({
    title,
    subtitle: `${status} · ${formatElapsed(elapsedMs)}`,
    template: 'wathet',
    elements: [
      ...(lines.length ? [md(lines.join('\n'), { size: 'notation' })] : [md("<font color='grey'>已收到，正在处理…</font>", { size: 'notation' })]),
      buttonRow([{ text: '⏹ 中断', command: '/abort', type: 'danger' }]),
    ],
  })
}

/** The final answer, with the run's steps folded away and a short footer. */
export function answerCard(options: {
  title: string
  text: string
  part?: { index: number; total: number }
  steps?: ProgressStep[]
  elapsedMs?: number
  model?: string
}): LarkCard {
  const { title, text, part, steps = [], elapsedMs, model } = options
  const elements: CardElement[] = [md(escapeMarkdown(text))]
  const last = !part || part.index === part.total - 1
  if (last && steps.length) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: `<font color='grey'>🔧 执行过程（${steps.length} 步）</font>` },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      padding: '4px 8px 4px 8px',
      elements: [md(steps.slice(-40).map(stepLine).join('\n'), { size: 'notation' })],
    })
  }
  if (last) {
    const footer = [
      ...(elapsedMs !== undefined ? [`⏱ ${formatElapsed(elapsedMs)}`] : []),
      ...(steps.length ? [`🔧 ${steps.length} 步`] : []),
      ...(model ? [inline(model)] : []),
    ].join(' · ')
    if (footer) elements.push(md(`<font color='grey'>${footer}</font>`, { size: 'notation' }))
  }
  return card({
    title: part && part.total > 1 ? `${title}（${part.index + 1}/${part.total}）` : title,
    template: 'turquoise',
    elements,
  })
}

/** The run ended without any answer text (aborted, error, or tool-only). */
export function endedCard(title: string, steps: ProgressStep[], elapsedMs: number, reason: string): LarkCard {
  const lines = steps.slice(-VISIBLE_STEPS).map(stepLine)
  return card({
    title,
    subtitle: `${reason} · ${formatElapsed(elapsedMs)}`,
    template: 'grey',
    elements: [md(lines.length ? lines.join('\n') : "<font color='grey'>本轮没有文字回复。</font>", { size: 'notation' })],
  })
}
