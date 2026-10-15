import type { ChatMessage } from '../../types'
import type { groupToolMessages } from './ToolGroup'

type GroupedItem = ReturnType<typeof groupToolMessages>[number]

/** A collapsed run of middle-of-turn activity (tools / thinking / interim replies). */
export interface CollapsedTurnItem {
  type: 'collapsed'
  /** Stable turn identity — survives prepends of older pages. */
  turnKey: string
  toolCount: number
  thinkingCount: number
  otherCount: number
}

export type RenderItem = GroupedItem | CollapsedTurnItem

interface Turn {
  key: string
  items: GroupedItem[]
}

/** Stable per-turn key; ts + role + a content prefix survives page prepends. */
function turnKeyOf(message: ChatMessage): string {
  return `${message.ts || ''}|${message.role}|${(message.content || '').slice(0, 60)}`
}

function itemMessage(item: GroupedItem): ChatMessage | null {
  return item.type === 'single' ? item.message : null
}

/** All message indices covered by a grouped item. */
function itemIndices(item: GroupedItem): number[] {
  return item.type === 'single' ? [item.index] : item.tools.map(t => t.index)
}

/**
 * Collapse older turns to a compact form: keep the user prompt and the turn's
 * final reply visible, hide the middle (tool calls, thinking, interim
 * assistant messages) behind a single expandable row. The newest `keepTurns`
 * turns are always rendered in full.
 *
 * Returns the render list plus a message-index -> turn-key map so callers can
 * auto-expand a turn before scrolling to a searched message inside it.
 */
export function collapseOldTurns(
  items: GroupedItem[],
  opts: { keepTurns: number; expandedTurns: Set<string> },
): { items: RenderItem[]; turnKeyByIndex: Map<number, string>; collapsibleTurnKeys: Set<string> } {
  const keepTurns = Math.max(1, opts.keepTurns)

  // Split into turns. A turn starts at a user message; anything before the
  // first user message belongs to an initial turn of its own.
  const turns: Turn[] = []
  for (const item of items) {
    const msg = itemMessage(item)
    if (turns.length === 0 || msg?.role === 'user') {
      const suffix = msg
        ? turnKeyOf(msg)
        : `pre|${item.type === 'group' ? `g${item.tools[0]?.index ?? 0}` : 'empty'}`
      turns.push({ key: suffix, items: [item] })
    } else {
      turns[turns.length - 1].items.push(item)
    }
  }

  const result: RenderItem[] = []
  const turnKeyByIndex = new Map<number, string>()
  const collapsibleTurnKeys = new Set<string>()
  const firstOpen = Math.max(0, turns.length - keepTurns)

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t]
    for (const item of turn.items) {
      for (const idx of itemIndices(item)) turnKeyByIndex.set(idx, turn.key)
    }

    const collapsible = t < firstOpen && !opts.expandedTurns.has(turn.key)
    if (!collapsible) {
      for (const item of turn.items) result.push(item)
      continue
    }

    // Keep the final reply (or trailing error) visible; everything else in
    // the middle folds into one row.
    let tailIdx = -1
    for (let i = turn.items.length - 1; i >= 0; i--) {
      const msg = itemMessage(turn.items[i])
      if (msg && (msg.role === 'assistant' || msg.role === 'error')) {
        tailIdx = i
        break
      }
    }

    const head: GroupedItem[] = []
    const hidden: GroupedItem[] = []
    let tail: GroupedItem | null = null
    for (let i = 0; i < turn.items.length; i++) {
      const item = turn.items[i]
      if (i === tailIdx) {
        tail = item
        continue
      }
      const msg = itemMessage(item)
      if (msg?.role === 'user') {
        head.push(item)
        continue
      }
      hidden.push(item)
    }

    if (hidden.length === 0) {
      // Nothing to hide — render the turn as-is.
      for (const item of turn.items) result.push(item)
      continue
    }

    let toolCount = 0
    let thinkingCount = 0
    let otherCount = 0
    for (const item of hidden) {
      const msg = itemMessage(item)
      if (item.type === 'group') toolCount += item.tools.length
      else if (msg?.role === 'thinking') thinkingCount += 1
      else if (msg?.role === 'tool') toolCount += 1
      else otherCount += 1
    }

    collapsibleTurnKeys.add(turn.key)
    for (const item of head) result.push(item)
    result.push({ type: 'collapsed', turnKey: turn.key, toolCount, thinkingCount, otherCount })
    if (tail) result.push(tail)
  }

  return { items: result, turnKeyByIndex, collapsibleTurnKeys }
}

/** One-line summary row that replaces the hidden middle of an old turn. */
export function CollapsedTurnRow({ item, onExpand }: { item: CollapsedTurnItem; onExpand: () => void }) {
  const parts: string[] = []
  if (item.toolCount > 0) parts.push(`${item.toolCount} tool call${item.toolCount === 1 ? '' : 's'}`)
  if (item.thinkingCount > 0) parts.push(`${item.thinkingCount} thinking block${item.thinkingCount === 1 ? '' : 's'}`)
  if (item.otherCount > 0) parts.push(`${item.otherCount} message${item.otherCount === 1 ? '' : 's'}`)
  return (
    <button
      type="button"
      className="w-full flex items-center gap-2 text-left bg-transparent border border-dashed border-border rounded-md px-3 py-1.5 text-body-s text-muted cursor-pointer hover:text-accent hover:border-accent transition-colors font-body"
      onClick={onExpand}
      title="Show the full activity for this turn"
    >
      <span className="text-2xs leading-none">▸</span>
      <span className="truncate">{parts.join(' · ') || 'hidden activity'}</span>
      <span className="ml-auto text-2xs opacity-60 shrink-0">show</span>
    </button>
  )
}

export default CollapsedTurnRow