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
 * The single chat message an agent receives for one review round. Every comment
 * carries its line reference, the quoted sentence it targets, and the feedback.
 */
export function buildReviewMessage(filePath: string, comments: Comment[]): string {
  const blocks = comments.map((comment, index) => {
    const quote = comment.quote ? `\nQuoted: "${comment.quote}"` : ''
    return `[${index + 1}] ${formatLineRef(comment)}${quote}\nComment: ${comment.content}`
  })
  const label = comments.length === 1 ? 'comment' : 'comments'
  return `Please review and address the ${label} in ${filePath}:\n\n${blocks.join('\n\n')}`
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