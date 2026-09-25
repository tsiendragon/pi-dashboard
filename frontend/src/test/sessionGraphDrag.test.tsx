/**
 * Card-dragging tests. The auto layout is only a default: crossing edges and a
 * crowded family are judgement calls, so a card can be dragged and the rest of the
 * drawing (edges, group titles, 适配) follows it.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { SessionNodeKind, SessionTreeGraph, SessionTreeNode } from '@shared/session-tree'
import SessionFamilyGraph from '../features/live-sessions/graph/SessionFamilyGraph'

function node(id: string, parentId: string | null, overrides: Partial<SessionTreeNode> = {}): SessionTreeNode {
  return {
    id,
    parentId,
    kind: 'message' as SessionNodeKind,
    sessionKey: 's',
    type: 'message',
    title: id,
    childCount: 0,
    isLeaf: false,
    isHead: false,
    ...overrides,
  }
}

const chain = [
  node('a', null, { childCount: 1 }),
  node('b', 'a', { childCount: 1 }),
  node('c', 'b', { isLeaf: true, isHead: true }),
]

function graphOf(nodes: SessionTreeNode[]): SessionTreeGraph {
  return {
    focusKey: 's',
    sessions: [{ key: 's', file: '/tmp/s.jsonl', sessionId: 's', entryCount: nodes.length, leafId: 'c', isFocus: true, isLive: true }],
    nodes,
    detail: 'collapsed',
    truncated: false,
    generatedAt: 0,
  }
}

/**
 * Dispatch a pointer event by hand: jsdom does not implement PointerEvent, and a
 * plain MouseEvent with a `pointer*` type carries the clientX/clientY that React's
 * pointer listener actually reads. Wrapped in `act` so the re-render has flushed
 * before the assertions run.
 */
function pointer(element: Element, type: string, init: { clientX: number; clientY: number }): void {
  act(() => {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init } as MouseEventInit))
  })
}

function cardOf(container: HTMLElement, id: string): SVGRectElement {
  const rect = container.querySelector<SVGRectElement>(`[data-node-id="${id}"] rect[rx="10"]`)
  if (!rect) throw new Error(`no card rect for ${id}`)
  return rect
}

function cardXY(container: HTMLElement, id: string): { x: number; y: number } {
  const rect = cardOf(container, id)
  return { x: Number(rect.getAttribute('x')), y: Number(rect.getAttribute('y')) }
}

function renderGraph(nodes: SessionTreeNode[]) {
  const onSelect = vi.fn()
  const result = render(
    <SessionFamilyGraph
      graph={graphOf(nodes)}
      selectedId={null}
      onSelect={onSelect}
      onOpenSession={vi.fn()}
      onToggleExpand={vi.fn()}
      onLoadMore={vi.fn()}
    />,
  )
  const svg = result.container.querySelector('svg')
  if (!svg) throw new Error('no svg')
  return { ...result, svg, onSelect }
}

/** Press, move, release — a real drag. */
function dragCard(container: HTMLElement, svg: Element, id: string, dx: number, dy: number): void {
  pointer(cardOf(container, id), 'pointerdown', { clientX: 100, clientY: 100 })
  pointer(svg, 'pointermove', { clientX: 100 + dx, clientY: 100 + dy })
  pointer(svg, 'pointerup', { clientX: 100 + dx, clientY: 100 + dy })
}

describe('card dragging', () => {
  it('moves only the dragged card', () => {
    const { container, svg } = renderGraph(chain)
    const before = cardXY(container, 'b')
    const anchor = cardXY(container, 'a')
    dragCard(container, svg, 'b', 60, 40)
    const after = cardXY(container, 'b')
    expect(after.x).toBeCloseTo(before.x + 60, 1)
    expect(after.y).toBeCloseTo(before.y + 40, 1)
    expect(cardXY(container, 'a')).toEqual(anchor)
  })

  it('keeps the incoming edge attached to the moved card', () => {
    const { container, svg } = renderGraph(chain)
    dragCard(container, svg, 'b', 60, 40)
    const moved = cardXY(container, 'b')
    const endpoints = [...container.querySelectorAll('path[marker-end]')].map(path => {
      const numbers = (path.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
      return { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] }
    })
    // The arrow into `b` must land on `b`'s new border, not on where it used to be.
    const onMovedLeftEdge = endpoints.some(end => Math.abs(end.x - moved.x) < 1.5)
    expect(onMovedLeftEdge).toBe(true)
  })

  it('grows the drawn bounds so 适配 can bring the card back into view', () => {
    const { container, svg } = renderGraph(chain)
    const bandBefore = Number(container.querySelector('[data-band-width]')?.getAttribute('data-band-width'))
    dragCard(container, svg, 'b', 200, 0)
    const bandAfter = Number(container.querySelector('[data-band-width]')?.getAttribute('data-band-width'))
    expect(bandAfter).toBeCloseTo(bandBefore + 200, 0)
  })

  it('still selects on a click that does not move', () => {
    const { container, svg, onSelect } = renderGraph(chain)
    pointer(cardOf(container, 'b'), 'pointerdown', { clientX: 100, clientY: 100 })
    pointer(svg, 'pointerup', { clientX: 100, clientY: 100 })
    fireEvent.click(cardOf(container, 'b'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe('b')
  })

  it('does not also select after a real drag', () => {
    const { container, svg, onSelect } = renderGraph(chain)
    dragCard(container, svg, 'b', 60, 40)
    fireEvent.click(cardOf(container, 'b'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('offers 重排 only after something was moved, and it restores the auto layout', () => {
    const { container, svg, queryByText, getByText } = renderGraph(chain)
    expect(queryByText('重排')).toBeNull()
    const before = cardXY(container, 'b')
    dragCard(container, svg, 'b', 60, 40)
    expect(cardXY(container, 'b').x).not.toBeCloseTo(before.x, 1)
    fireEvent.click(getByText('重排'))
    expect(cardXY(container, 'b')).toEqual(before)
    expect(queryByText('重排')).toBeNull()
  })
})

/** `a → run:h1 → head`, with the folded run expanded so it lists its steps. */
function expandedGraph(): SessionTreeNode[] {
  return [
    node('a', null, { childCount: 1 }),
    node('run:h1', 'a', {
      kind: 'collapsed' as SessionNodeKind,
      collapsedCount: 3,
      expanded: true,
      childCount: 1,
      steps: [
        node('s1', 'run:h1', { title: 'step-one' }),
        node('s2', 'run:h1', { title: 'step-two' }),
        node('s3', 'run:h1', { title: 'step-three' }),
      ],
    }),
    node('head', 'run:h1', { isLeaf: true, isHead: true }),
  ]
}

describe('card press vs click', () => {
  it('does not capture the pointer on press, only once a real drag starts', () => {
    const { container, svg } = renderGraph(chain)
    const capture = vi.fn()
    Object.assign(svg, { setPointerCapture: capture })
    pointer(cardOf(container, 'b'), 'pointerdown', { clientX: 100, clientY: 100 })
    // Capturing here would make the browser retarget the following `click` at the
    // SVG, which is exactly how the card's step rows stopped being clickable.
    expect(capture).not.toHaveBeenCalled()
    pointer(svg, 'pointermove', { clientX: 102, clientY: 100 })
    expect(capture).not.toHaveBeenCalled()
    pointer(svg, 'pointermove', { clientX: 160, clientY: 140 })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('still selects a step row inside an expanded card', () => {
    const { container, onSelect } = renderGraph(expandedGraph())
    const row = [...container.querySelectorAll('[data-node-id="run:h1"] g')]
      // The innermost <g>: wrappers (clip / scroll offset) contain the same text.
      .filter(element => !element.querySelector('g'))
      .find(element => element.textContent?.includes('step-two'))
    expect(row).toBeTruthy()
    pointer(row!, 'pointerdown', { clientX: 100, clientY: 100 })
    fireEvent.click(row!)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe('s2')
  })
})