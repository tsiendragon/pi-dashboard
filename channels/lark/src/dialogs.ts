/**
 * Extension dialogs in the chat.
 *
 * Some commands pause and wait for a human: `/goal` asks Start / Edit / Cancel
 * after drafting a proposal, `/effort` without a level opens a picker, and any
 * extension may `ctx.ui.confirm(...)`. pi blocks on that answer, so a chat that
 * never shows the question looks frozen — the session accepts no further input
 * until somebody answers, usually from the web UI.
 *
 * This module renders such a request as a card whose buttons carry the same
 * `answer_ui` payload the web UI sends, so either side can settle it (first
 * answer wins, upstream).
 */

import { buttonRow, card, escapeMarkdown, inline, md, type ButtonSpec, type CardElement, type LarkCard } from './cards.js'

export type DialogMethod = 'confirm' | 'select' | 'input' | 'editor'

export interface DialogView {
  id: string
  method: DialogMethod
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
}

/** Long "editor" bodies are summarized in the card; the web UI keeps the full text. */
const MESSAGE_LIMIT = 1200
/** Buttons per card; the rest stay reachable from the web UI. */
const OPTION_LIMIT = 8
const INPUT_HINT: Record<'input' | 'editor', string> = {
  input: '直接在本聊天里回复内容，就当作这个问题的答案。',
  editor: '直接在本聊天里回复内容，会整段作为提交的文本。',
}

export function dialogMethodOf(value: unknown): DialogMethod | undefined {
  return value === 'confirm' || value === 'select' || value === 'input' || value === 'editor' ? value : undefined
}

/** `true` when the answer must come from a chat message rather than a button. */
export function needsTextAnswer(method: DialogMethod): method is 'input' | 'editor' {
  return method === 'input' || method === 'editor'
}

/**
 * The card for a pending dialog.
 * `open` waits for an answer, `answered` shows what was chosen, `closed` says it
 * was settled elsewhere (web UI, terminal, or a timeout upstream).
 */
export function dialogCard(dialog: DialogView, state: 'open' | 'answered' | 'closed', answeredWith?: string): LarkCard {
  const elements: CardElement[] = []
  const body: string[] = []
  if (dialog.message) {
    const text = dialog.message.length > MESSAGE_LIMIT ? `${dialog.message.slice(0, MESSAGE_LIMIT)}\n…（共 ${dialog.message.length} 字，完整内容见网页端）` : dialog.message
    body.push(escapeMarkdown(text))
  }
  if (state === 'open' && needsTextAnswer(dialog.method)) body.push(`<font color='grey'>${INPUT_HINT[dialog.method]}</font>`)
  if (state === 'open' && dialog.method === 'select' && (dialog.options?.length ?? 0) > OPTION_LIMIT) {
    body.push(`<font color='grey'>选项较多，这里只列出前 ${OPTION_LIMIT} 个，其余请在网页端选择。</font>`)
  }
  if (body.length) elements.push(md(body.join('\n')))

  const buttons: ButtonSpec[] = []
  if (state === 'open') {
    if (dialog.method === 'confirm') {
      buttons.push({ text: '✅ 确认', answer: { id: dialog.id, value: 'true' }, type: 'primary' })
    }
    if (dialog.method === 'select') {
      for (const option of (dialog.options ?? []).slice(0, OPTION_LIMIT)) {
        buttons.push({ text: option, answer: { id: dialog.id, value: option } })
      }
    }
    buttons.push({ text: '取消', answer: { id: dialog.id, cancelled: true }, type: 'danger' })
  } else {
    const note =
      state === 'answered'
        ? `✅ 已回答${answeredWith ? `：${inline(answeredWith)}` : ''}`
        : "<font color='grey'>已在其它端处理（网页端或终端）。</font>"
    elements.push(md(note, { size: 'notation' }))
  }
  if (buttons.length) elements.push(buttonRow(buttons))

  return card({
    title: state === 'open' ? `❓ ${dialog.title || '需要你确认'}` : dialog.title || '待确认',
    subtitle: state === 'open' ? subtitleFor(dialog) : undefined,
    template: state === 'open' ? 'orange' : 'grey',
    elements,
  })
}

function subtitleFor(dialog: DialogView): string {
  switch (dialog.method) {
    case 'confirm': return '会话在等你的确认，不回答就无法继续'
    case 'select': return '点下面的按钮选择一个，会话会接着往下走'
    case 'input': return '会话在等一段输入'
    default: return '会话在等一段文本'
  }
}

/** One-line log/toast label for a dialog. */
export function dialogLabel(dialog: DialogView): string {
  return `${dialog.method}:${dialog.title || dialog.id}`
}