import type { Comment } from '../hooks/usePanelState'

/** Longest quoted sentence kept in a review message; longer quotes are ellipsized. */
export const MAX_QUOTE_CHARS = 160

/**
 * Collapse a selection into a single-line quote so the review message stays
 * readable and each comment keeps the exact sentence it was written on.
 */
export function normalizeQuote(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  if (flat.length <= MAX_QUOTE_CHARS) return flat
  return `${flat.slice(0, MAX_QUOTE_CHARS - 1)}…`
}

/** Human-readable line reference shared by the UI and the agent message. */
export function formatLineRef(comment: Pick<Comment, 'startLine' | 'endLine'>): string {
  return comment.startLine === comment.endLine
    ? `Line ${comment.startLine}`
    : `Lines ${comment.startLine}-${comment.endLine}`
}

/**
 * One quoted piece of conversation (a selected sentence plus where it came from).
 * Shared by the composer's quote chips and the conversation comment box.
 */
export interface QuotedText {
  id: string
  /** Whitespace-collapsed, length-capped quote. */
  text: string
  /** `user` | `assistant` (or undefined when the source is unknown). */
  role?: string
  /** Session entry id of the message the quote came from, when known. */
  entryId?: string
}

/**
 * One reviewable item: what to point at (label + quote) and what to say.
 * Document comments fill `label` with a line reference; conversation quotes
 * fill it with the speaker.
 */
export interface ReviewItem {
  id: string
  label?: string
  quote?: string
  content: string
}

/** "你的回复" / "我的消息" / "会话内容" — who wrote the quoted text. */
export function selectionLabel(role?: string): string {
  if (role === 'assistant') return '你的回复'
  if (role === 'user') return '我的消息'
  return '会话内容'
}

/** Map stored document comments onto dialog items. */
export function commentReviewItems(comments: Comment[]): ReviewItem[] {
  return comments.map(c => ({
    id: c.id,
    label: formatLineRef(c),
    ...(c.quote ? { quote: c.quote } : {}),
    content: c.content,
  }))
}

function quoteBlock(quote: string, label?: string): string {
  const head = label ? `引用（来自${label}）：` : '引用：'
  const body = quote
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
  return `${head}\n${body}`
}

/**
 * Prefix for a chat reply built from selected text: each quote becomes a
 * markdown blockquote so the agent reads it as quoted context, and the user's
 * own words follow as the actual message.
 */
export function buildQuoteReplyMessage(quotes: QuotedText[]): string {
  return quotes
    .map(quote => quoteBlock(quote.text, selectionLabel(quote.role)))
    .join('\n\n')
}

/** Opening line used when the comments target the conversation itself. */
export const CHAT_REVIEW_INTRO = 'Please review and address these comments about the quoted parts of our conversation:'

/** Headline `buildReviewMessage` writes when no intro is given (document comments). */
const FILE_REVIEW_HEAD = /^Please review and address the comments? in .+:$/
/** First line of a quote reply block: `引用（来自 Agent 回复）：`. */
const QUOTE_REPLY_HEAD = /^引用（来自.+）：$|^引用：$/

export type FollowUpKind = 'quote' | 'comment'

/**
 * What kind of follow-up this chat message is, or undefined for an ordinary one.
 *
 * Both shapes are built by this module, so recognising them by their own markers
 * is exact — the timeline can merge a quote or a comment round into the activity
 * it belongs to instead of splitting the work in two.
 */
export function quoteOrCommentKind(text: string): FollowUpKind | undefined {
  // Attached-file text and images are prefixed before the quote block, so look
  // through the opening lines instead of trusting the very first one.
  const head = text.split('\n', 12).map(line => line.trim()).filter(Boolean)
  if (head.some(line => line === CHAT_REVIEW_INTRO || FILE_REVIEW_HEAD.test(line))) return 'comment'
  if (head.some(line => QUOTE_REPLY_HEAD.test(line)) && /^> /m.test(text)) return 'quote'
  return undefined
}

/**
 * The sentences a follow-up points at: quoted lines of a quote reply, or the
 * `Quoted: "…"` entries of a comment round. Used to find the activity the note
 * belongs to.
 */
export function quotedSnippets(text: string): string[] {
  const snippets: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const comment = /^Quoted: "(.*)"$/.exec(line)
    if (comment?.[1]) snippets.push(comment[1])
    else if (line.startsWith('> ')) snippets.push(line.slice(2))
  }
  return snippets
}

/**
 * The single chat message an agent receives for one review round. Every item
 * carries what it points at, the quoted text, and the feedback.
 */
export function buildReviewMessage(target: string, items: ReviewItem[], intro?: string): string {
  const blocks = items.map((item, index) => {
    const head = item.label ? `[${index + 1}] ${item.label}` : `[${index + 1}]`
    const quote = item.quote ? `\nQuoted: "${item.quote}"` : ''
    return `${head}${quote}\nComment: ${item.content}`
  })
  const headline = intro ?? `Please review and address the ${items.length === 1 ? 'comment' : 'comments'} in ${target}:`
  return `${headline}\n\n${blocks.join('\n\n')}`
}

/** Strip markdown formatting for fuzzy text matching */
export function stripMd(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')              // headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic
    .replace(/`([^`]+)`/g, '$1')            // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images (must precede link rule)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/^[-*+]\s+/, '')                // unordered list items
    .replace(/^\d+\.\s+/, '')                // ordered list items
    .replace(/^>\s+/, '')                    // blockquotes
    .trim()
}

/**
 * Reverse-map selected rendered text back to source line numbers.
 * Preview mode renders markdown/code, so the selection is matched against the
 * raw content first and then against markdown-stripped source lines.
 */
export function resolveSelectionToLines(content: string, selText: string): { startLine: number; endLine: number } {
  const lines = content.split('\n')
  let startLine = 1
  let endLine = 1
  const needle = selText.split('\n').map(l => l.trim()).filter(Boolean)[0]?.toLowerCase() || ''
  if (needle.length > 0) {
    // Strategy 1: exact substring match in raw content
    const idx = content.toLowerCase().indexOf(needle)
    if (idx >= 0) {
      startLine = content.slice(0, idx).split('\n').length
    } else {
      // Strategy 2: match against markdown-stripped source lines
      for (let i = 0; i < lines.length; i++) {
        const stripped = stripMd(lines[i]).toLowerCase()
        if (stripped.length > 0 && (stripped.includes(needle) || needle.includes(stripped))) {
          startLine = i + 1
          break
        }
      }
    }
    const selLineCount = selText.split('\n').filter(l => l.trim()).length
    endLine = Math.min(startLine + Math.max(0, selLineCount - 1), lines.length)
  }
  return { startLine, endLine }
}

/** Quote + line reference as a single 2xs label, used next to comment inputs. */
export function describeCommentTarget(startLine: number, endLine: number, quote?: string): string {
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`
  return quote ? `${range} — “${quote}”` : range
}