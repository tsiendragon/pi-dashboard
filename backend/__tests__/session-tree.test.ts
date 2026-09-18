/**
 * Tests for the session-family graph builder (`/api/live-sessions/:id/tree`).
 *
 * Fixtures mirror the real on-disk shape verified against live session files:
 * a forked session file repeats its parent's leading prefix with identical entry
 * ids, then appends its own entries, and records the parent path in
 * `header.parentSession`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSessionFamilyGraph,
  collapseLinearRuns,
  resetSessionTreeCaches,
  sessionKeyForFile,
  type SessionTreeNode,
} from '../live-sessions/session-tree.js'

const TS = '2026-01-01T00:00:00.000Z'
const PROJECT_DIR = '--tmp-tree-test--'

let root: string
let previousOverride: string | undefined

function header(id: string, parentSession?: string): string {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: TS,
    cwd: '/tmp/tree-test',
    ...(parentSession ? { parentSession } : {}),
  })
}

function entry(type: string, id: string, parentId: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, id, parentId, timestamp: TS, ...extra })
}

function user(id: string, parentId: string | null): string {
  return entry('message', id, parentId, { message: { role: 'user', content: [{ type: 'text', text: `user message ${id}` }] } })
}

function assistant(id: string, parentId: string | null, tools?: string[]): string {
  const content: unknown[] = [{ type: 'text', text: `assistant reply ${id}` }]
  for (const name of tools ?? []) content.push({ type: 'toolCall', name, arguments: {} })
  return entry('message', id, parentId, { message: { role: 'assistant', content } })
}

function writeSession(name: string, lines: string[]): string {
  const dir = join(root, PROJECT_DIR)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-session-tree-'))
  previousOverride = process.env.PI_DASH_SESSIONS_DIR
  process.env.PI_DASH_SESSIONS_DIR = root
  resetSessionTreeCaches()
})

afterEach(() => {
  if (previousOverride === undefined) delete process.env.PI_DASH_SESSIONS_DIR
  else process.env.PI_DASH_SESSIONS_DIR = previousOverride
  resetSessionTreeCaches()
  rmSync(root, { recursive: true, force: true })
})

describe('buildSessionFamilyGraph', () => {
  it('links a forked session to its parent without duplicating the copied prefix', async () => {
    const parentFile = writeSession('parent', [
      header('parent-id'),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
      assistant('a4', 'u3'),
      user('u5', 'a4'),
    ])
    const childFile = writeSession('child', [
      header('child-id', parentFile),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
      assistant('a4', 'u3'),
      user('u5', 'a4'),
      user('u6', 'u5'),
      assistant('a7', 'u6'),
    ])

    const graph = await buildSessionFamilyGraph({ sessionFile: childFile })

    expect(graph.focusKey).toBe(sessionKeyForFile(childFile))
    expect(graph.truncated).toBe(false)
    expect(graph.sessions.map(session => session.key)).toEqual([sessionKeyForFile(childFile), sessionKeyForFile(parentFile)])

    const focus = graph.sessions[0]
    expect(focus.isFocus).toBe(true)
    expect(focus.forkOf).toBe(sessionKeyForFile(parentFile))
    expect(focus.forkAnchorId).toBe('u5')
    expect(focus.leafId).toBe('a7')

    // Parent prefix rendered once + child-only tail, with the middle of the
    // parent's chain folded into one segment (folding keeps start / fork anchor /
    // child start / head as the only survivors).
    expect(graph.nodes.map(node => node.id)).toEqual(['u1', 'run:a2', 'u5', 'u6', 'a7'])
    const anchor = graph.nodes.find(node => node.id === 'u5')
    expect(anchor?.isForkAnchor).toBe(true)
    expect(anchor?.childCount).toBe(1)
    expect(graph.nodes.find(node => node.id === 'u6')?.parentId).toBe('u5')
    expect(graph.nodes.find(node => node.id === 'u5')?.sessionKey).toBe(sessionKeyForFile(parentFile))
    expect(graph.nodes.find(node => node.id === 'u6')?.sessionKey).toBe(sessionKeyForFile(childFile))
    expect(graph.nodes.find(node => node.id === 'a7')?.isHead).toBe(true)
    // Every real entry is either rendered or accounted for by a folded range.
    const folded = graph.nodes.filter(node => node.kind === 'collapsed')
    expect(folded.reduce((total, node) => total + (node.collapsedCount ?? 0), 0)).toBe(3)
  })

  it('expands one folded run in place without changing the graph topology', async () => {
    const file = writeSession('expandable', [
      header('expand-id'),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
      assistant('a4', 'u3'),
      user('u5', 'a4'),
      assistant('a6', 'u5'),
    ])

    const folded = await buildSessionFamilyGraph({ sessionFile: file })
    const runId = folded.nodes.find(node => node.kind === 'collapsed')?.id as string
    expect(runId).toBe('run:a2')

    const expanded = await buildSessionFamilyGraph({ sessionFile: file, expandRuns: new Set([runId]) })
    // The canvas topology is identical: expansion is nested data, not new nodes.
    expect(expanded.nodes.map(node => node.id)).toEqual(folded.nodes.map(node => node.id))
    const node = expanded.nodes.find(candidate => candidate.id === runId)
    expect(node?.expanded).toBe(true)
    expect(node?.steps?.map(step => step.id)).toEqual(['a2', 'u3', 'a4', 'u5'])
    expect(node?.stepsTruncated).toBeUndefined()
    // A run that was not requested stays folded.
    expect(folded.nodes.some(candidate => candidate.expanded)).toBe(false)
  })

  it('pages a long run: the per-run step window is respected and can be raised', async () => {
    const lines = [header('long-id'), user('u0', null)]
    let previous = 'u0'
    for (let index = 1; index <= 450; index += 1) {
      const id = `s${index}`
      lines.push(assistant(id, previous))
      previous = id
    }
    const file = writeSession('long', lines)

    const folded = await buildSessionFamilyGraph({ sessionFile: file })
    const runId = folded.nodes.find(node => node.kind === 'collapsed')?.id as string
    const at = async (limit: number) => {
      const graph = await buildSessionFamilyGraph({ sessionFile: file, expandRuns: new Set([runId]), expandStepLimit: limit })
      return graph.nodes.find(candidate => candidate.id === runId)
    }

    // Default window is 400; the run's real size stays reported by collapsedCount
    // (the chain is s1..s449; s450 is the head).
    const first = await at(400)
    expect(first?.steps).toHaveLength(400)
    expect(first?.stepsTruncated).toBe(true)
    expect(first?.collapsedCount).toBe(449)
    expect(first?.steps?.[0]?.id).toBe('s1')

    // “加载更多” just raises the window for the same run.
    const more = await at(800)
    expect(more?.steps).toHaveLength(449)
    expect(more?.stepsTruncated).toBeUndefined()
    expect(more?.steps?.at(-1)?.id).toBe('s449')
    expect(more?.steps?.[0]?.id).toBe('s1')

    // Absurd values are clamped rather than honoured (server-side ceiling).
    expect((await at(Number.MAX_SAFE_INTEGER))?.steps).toHaveLength(449)
    expect((await at(0))?.steps).toHaveLength(1)
  })

  it('renders a purely linear session as start -> folded run -> end', async () => {
    const file = writeSession('linear', [
      header('linear-id'),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
      assistant('a4', 'u3'),
      user('u5', 'a4'),
      assistant('a6', 'u5'),
    ])

    const folded = await buildSessionFamilyGraph({ sessionFile: file })
    expect(folded.detail).toBe('collapsed')
    expect(folded.nodes.map(node => node.id)).toEqual(['u1', 'run:a2', 'a6'])
    const segment = folded.nodes.find(node => node.kind === 'collapsed')
    expect(segment?.title).toBe('+4 步')
    expect(segment?.collapsedRange).toEqual({ from: 'a2', to: 'u5' })
    expect(folded.nodes.find(node => node.id === 'a6')?.parentId).toBe('run:a2')

    // The “显示步骤” escape hatch returns every entry.
    const expanded = await buildSessionFamilyGraph({ sessionFile: file, expandLinearRuns: true })
    expect(expanded.detail).toBe('full')
    expect(expanded.nodes.map(node => node.id)).toEqual(['u1', 'a2', 'u3', 'a4', 'u5', 'a6'])
    expect(expanded.nodes.some(node => node.kind === 'collapsed')).toBe(false)
  })

  it('chains multi-level forks (A -> B -> C) without duplicating any prefix', async () => {
    // A: [u1 a2 u3];  B = copy(A) + [u4 a5];  C = copy(B) + [u6 a7]
    const aFile = writeSession('a', [
      header('a-id'),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
    ])
    const bFile = writeSession('b', [
      header('b-id', aFile),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
      user('u4', 'u3'),
      assistant('a5', 'u4'),
    ])
    const cFile = writeSession('c', [
      header('c-id', bFile),
      user('u1', null),
      assistant('a2', 'u1'),
      user('u3', 'a2'),
      user('u4', 'u3'),
      assistant('a5', 'u4'),
      user('u6', 'a5'),
      assistant('a7', 'u6'),
    ])

    const graph = await buildSessionFamilyGraph({ sessionFile: cFile })

    // Focus first, then the ancestor chain nearest-first.
    expect(graph.sessions.map(session => session.key)).toEqual([
      sessionKeyForFile(cFile), sessionKeyForFile(bFile), sessionKeyForFile(aFile),
    ])
    // Middle session anchors to A, focus anchors to B; every entry appears exactly once.
    expect(graph.sessions[1].forkOf).toBe(sessionKeyForFile(aFile))
    expect(graph.sessions[1].forkAnchorId).toBe('u3')
    expect(graph.sessions[2].forkOf).toBeUndefined()
    expect(graph.sessions[0].forkAnchorId).toBe('a5')
    expect(graph.nodes.map(node => node.id).sort()).toEqual(['a2', 'a5', 'a7', 'u1', 'u3', 'u4', 'u6'])
    expect(graph.nodes).toHaveLength(7)
    expect(graph.nodes.filter(node => node.id === 'a5')[0].isForkAnchor).toBe(true)
    expect(graph.nodes.filter(node => node.id === 'u3')[0].isForkAnchor).toBe(true)
    expect(graph.nodes.filter(node => node.id === 'u6')[0].parentId).toBe('a5')
    expect(graph.nodes.filter(node => node.id === 'u4')[0].parentId).toBe('u3')
  })

  it('keeps forkOf when the parent file is gone', async () => {
    const missingParent = join(root, PROJECT_DIR, 'gone.jsonl')
    const childFile = writeSession('orphan', [
      header('orphan-id', missingParent),
      user('u1', null),
    ])
    const graph = await buildSessionFamilyGraph({ sessionFile: childFile })
    expect(graph.sessions[0].forkOf).toBe('gone')
    // Prefix could not be matched, so there is no anchor.
    expect(graph.sessions[0].forkAnchorId).toBeNull()
    expect(graph.nodes.map(node => node.id)).toEqual(['u1'])
  })

  it('builds a single-session graph when nothing was forked', async () => {
    const file = writeSession('solo', [
      header('solo-id'),
      user('u1', null),
      assistant('a2', 'u1'),
    ])
    const graph = await buildSessionFamilyGraph({ sessionFile: file })
    expect(graph.sessions).toHaveLength(1)
    expect(graph.sessions[0].forkOf).toBeUndefined()
    expect(graph.nodes.map(node => node.id)).toEqual(['u1', 'a2'])
    expect(graph.nodes.find(node => node.id === 'a2')?.isHead).toBe(true)
  })

  it('reads the label entries as node labels instead of nodes', async () => {
    const file = writeSession('labeled', [
      header('labeled-id'),
      user('u1', null),
      entry('label', 'l1', 'u1', { targetId: 'u1', label: 'checkpoint' }),
      assistant('a2', 'u1'),
    ])
    const graph = await buildSessionFamilyGraph({ sessionFile: file })
    expect(graph.nodes.map(node => node.id)).toEqual(['u1', 'a2'])
    expect(graph.nodes.find(node => node.id === 'u1')?.label).toBe('checkpoint')
  })

  it('surfaces tool calls on assistant nodes', async () => {
    const file = writeSession('tools', [
      header('tools-id'),
      user('u1', null),
      assistant('a2', 'u1', ['bash', 'read']),
    ])
    const graph = await buildSessionFamilyGraph({ sessionFile: file })
    const node = graph.nodes.find(candidate => candidate.id === 'a2')
    expect(node?.kind).toBe('tool')
    expect(node?.tools).toEqual(['bash', 'read'])
  })

  it('marks the session as live when its sessionId is attached', async () => {
    const file = writeSession('live', [header('live-id'), user('u1', null)])
    const graph = await buildSessionFamilyGraph({ sessionFile: file, liveSessionIds: new Set(['live-id']) })
    expect(graph.sessions[0].isLive).toBe(true)
  })

  it('rejects a session file outside the pi sessions dir instead of returning an empty graph', async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'pi-session-tree-outside-'))
    const outside = join(outsideRoot, 'outside.jsonl')
    writeFileSync(outside, `${header('outside-id')}\n`, 'utf8')
    try {
      await expect(buildSessionFamilyGraph({ sessionFile: outside }))
        .rejects.toMatchObject({ code: 'session_file_out_of_scope' })
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('reports a missing session file as not-found instead of an empty graph', async () => {
    const missing = join(root, PROJECT_DIR, 'never-written.jsonl')
    await expect(buildSessionFamilyGraph({ sessionFile: missing }))
      .rejects.toMatchObject({ code: 'session_file_not_found' })
  })

  it('parses oversized session files from a bounded tail window', async () => {
    const lines = [header('big-id'), user('u1', null), assistant('a2', 'u1')]
    const filler = entry('custom', 'filler-template', null, { customType: 'filler', data: 'x'.repeat(80) })
    // ~21MB (> SESSION_TREE_MAX_PARSE_BYTES) so the tail-read path is exercised.
    for (let index = 0; index < 180_000; index += 1) lines.push(filler.replace('filler-template', `f${index}`))
    lines.push(user('last', null))
    const file = writeSession('big', lines)

    const graph = await buildSessionFamilyGraph({ sessionFile: file })
    expect(graph.sessions[0].partial).toBe(true)
    // The tail window must still yield well-formed nodes and a leaf.
    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.sessions[0].leafId).toBe('last')
    expect(graph.nodes.some(node => node.isHead)).toBe(true)
  })
})

describe('collapseLinearRuns', () => {
  const node = (id: string, parentId: string | null, overrides: Partial<SessionTreeNode> = {}): SessionTreeNode => ({
    id,
    parentId,
    kind: 'message',
    sessionKey: 's',
    type: 'message',
    title: id,
    childCount: 0,
    isLeaf: false,
    isHead: false,
    ...overrides,
  })

  it('folds a long assistant-only chain into one collapsed node', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `a${index + 1}`)
    const nodes = ids.map((id, index) => node(id, index === 0 ? null : ids[index - 1]))
    nodes[ids.length - 1] = { ...nodes[ids.length - 1], isHead: true, isLeaf: true }
    nodes.forEach(candidate => { candidate.childCount = candidate.isLeaf ? 0 : 1 })

    const out = collapseLinearRuns(nodes, new Set(['a1']))
    const collapsed = out.filter(candidate => candidate.kind === 'collapsed')
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].collapsedCount).toBe(8)
    expect(collapsed[0].collapsedRange).toEqual({ from: 'a2', to: 'a9' })
    // start → folded run → end, with the run's children re-hung off the fold.
    expect(out.map(candidate => candidate.id)).toEqual(['a1', 'run:a2', 'a10'])
    expect(out.find(candidate => candidate.id === 'a10')?.parentId).toBe('run:a2')
  })

  it('keeps short runs unfolded and never folds structural nodes', () => {
    const nodes = [node('a1', null, { childCount: 1 }), node('a2', 'a1', { isLeaf: true, isHead: true })]
    expect(collapseLinearRuns(nodes, new Set(['a1'])).map(candidate => candidate.id)).toEqual(['a1', 'a2'])
  })
})