/**
 * Lark interactive cards (card JSON 2.0).
 *
 * Every chat reply can carry a card next to its plain-text form. The Lark
 * transport sends the card; transports without card support (stdio, tests) and
 * any card the server rejects fall back to the text, so a card is never the only
 * way a reply can reach the chat.
 *
 * Buttons carry `{ cmd: '/xxx …' }` as their callback value; a click is run
 * exactly like the user typing that command (see Gateway.onCardAction).
 */

export type LarkCard = Record<string, unknown>
export type CardElement = Record<string, unknown>

/** A command reply: plain text plus an optional card rendering of the same content. */
export interface RichReply {
  text: string
  card?: LarkCard
}
export type Reply = string | RichReply

export function replyText(reply: Reply): string {
  return typeof reply === 'string' ? reply : reply.text
}

/**
 * Cards are capped at ~30 KB of JSON. CJK text is 3 bytes in UTF-8, so this many
 * characters per card leaves room for the header, buttons and JSON escaping.
 */
export const CARD_TEXT_LIMIT = 7000

export type HeaderTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey'

export interface ButtonSpec {
  text: string
  /** Command run when clicked, exactly as if typed into the chat. */
  command: string
  type?: 'default' | 'primary' | 'danger' | 'primary_filled' | 'danger_filled' | 'laser'
  /** Ask before running (destructive commands). */
  confirm?: { title: string; text: string }
}

export function card(options: { title?: string; subtitle?: string; template?: HeaderTemplate; elements: CardElement[] }): LarkCard {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    ...(options.title
      ? {
          header: {
            title: { tag: 'plain_text', content: clip(options.title, 100) },
            ...(options.subtitle ? { subtitle: { tag: 'plain_text', content: clip(options.subtitle, 100) } } : {}),
            template: options.template ?? 'blue',
            padding: '10px 12px 10px 12px',
          },
        }
      : {}),
    body: { direction: 'vertical', padding: '10px 12px 12px 12px', vertical_spacing: '8px', elements: options.elements },
  }
}

/** A markdown block. `content` must already be card-safe (see `escapeMarkdown`). */
export function md(content: string, options: { size?: 'normal' | 'notation' } = {}): CardElement {
  return { tag: 'markdown', content, ...(options.size === 'notation' ? { text_size: 'notation' } : {}) }
}

export function hr(): CardElement {
  return { tag: 'hr' }
}

export function button(spec: ButtonSpec): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.type ?? 'default',
    size: 'small',
    behaviors: [{ type: 'callback', value: { cmd: spec.command } }],
    ...(spec.confirm
      ? { confirm: { title: { tag: 'plain_text', content: spec.confirm.title }, text: { tag: 'plain_text', content: spec.confirm.text } } }
      : {}),
  }
}

/** A row of buttons that wraps on narrow (mobile) screens. */
export function buttonRow(specs: ButtonSpec[]): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: specs.map(spec => ({ tag: 'column', width: 'auto', elements: [button(spec)] })),
  }
}

/** Text on the left, one action on the right — a list row. */
export function actionRow(markdown: string, action?: ButtonSpec): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [md(markdown)] },
      ...(action ? [{ tag: 'column', width: 'auto', vertical_align: 'center', elements: [button(action)] }] : []),
    ],
  }
}

/** A plain notice card (no header): used for short acknowledgements. */
export function noticeCard(text: string): LarkCard {
  return card({ elements: [md(escapeMarkdown(text))] })
}

/**
 * Make agent / user text safe for a card markdown block.
 *
 * Card markdown treats `<…>` as its own tags (`<at>`, `<font>`, …), so a stray
 * `<T>` or `a < b` in an answer can swallow text or fail the whole card. Outside
 * code, angle brackets become HTML entities; code spans and fences are left
 * untouched because the card renders them verbatim.
 */
export function escapeMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
  return parts
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/</g, '&#60;').replace(/>/g, '&#62;')))
    .join('')
}

/** Escape for inline use in our own card copy (labels, paths). */
export function inline(text: string): string {
  return escapeMarkdown(text).replace(/([*_~`[\]])/g, '\\$1')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
