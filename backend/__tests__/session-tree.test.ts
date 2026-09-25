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
  readSessionCompactions,
  resetSessionTreeCaches,
  sessionKeyForFile,
  turnSteps,
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
    // Every real entry is either rendered or covered by a folded range. The folded
    // COUNT is turns now ([a2] and [u3 → a4]), so coverage is asserted on the range.
    const folded = graph.nodes.filter(node => node.kind === 'collapsed')
    expect(folded.map(node => node.collapsedRange)).toEqual([{ from: 'a2', to: 'a4' }])
    // `a2` is the prelude of `u3`'s request, so the run is ONE turn.
    expect(folded[0]?.collapsedCount).toBe(1)
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
    // One row per agent turn, not per record: `u3`'s turn (with `a2` as its prelude and
    // `a4` as its reply), then `u5`'s turn (its reply is the head, outside the run).
    expect(node?.steps?.map(step => step.id)).toEqual(['u3', 'u5'])
    expect(node?.steps?.map(step => step.title)).toEqual(['User', 'User'])
    expect(node?.steps?.[0]?.preview).toBe('user message u3')
    expect(node?.steps?.[0]?.reply).toBe('assistant reply a4')
    expect(node?.steps?.[0]?.coveredCount).toBe(3)
    expect(node?.steps?.[1]?.preview).toBe('user message u5')
    expect(node?.steps?.[1]?.reply).toBeUndefined()
    expect(node?.stepsTruncated).toBeUndefined()
    // A run that was not requested stays folded.
    expect(folded.nodes.some(candidate => candidate.expanded)).toBe(false)
  })

  it('pages a long run: the per-run step window is respected and can be raised', async () => {
    // A real long conversation is alternating user/assistant records, i.e. one turn per
    // pair; a step is a turn, so the window counts turns.
    const lines = [header('long-id'), user('u0', null)]
    let previous = 'u0'
    for (let index = 1; index <= 450; index += 1) {
      const userId = `u${index}`
      const assistantId = `a${index}`
      lines.push(user(userId, previous))
      lines.push(assistant(assistantId, userId))
      previous = assistantId
    }
    const file = writeSession('long', lines)

    const folded = await buildSessionFamilyGraph({ sessionFile: file })
    const runId = folded.nodes.find(node => node.kind === 'collapsed')?.id as string
    const at = async (limit: number) => {
      const graph = await buildSessionFamilyGraph({ sessionFile: file, expandRuns: new Set([runId]), expandStepLimit: limit })
      return graph.nodes.find(candidate => candidate.id === runId)
    }

    // Default window is 400 turns; the run's real size stays reported by collapsedCount.
    // The run is u1..a449 plus the trailing u450 (whose reply a450 is the head) = 450 turns.
    const first = await at(400)
    expect(first?.steps).toHaveLength(400)
    expect(first?.stepsTruncated).toBe(true)
    expect(first?.collapsedCount).toBe(450)
    // A row stands for a turn and keeps the turn's first entry id.
    expect(first?.steps?.[0]?.id).toBe('u1')
    expect(first?.steps?.[0]?.reply).toBe('assistant reply a1')

    // “加载更多” just raises the window for the same run.
    const more = await at(800)
    expect(more?.steps).toHaveLength(450)
    expect(more?.stepsTruncated).toBeUndefined()
    expect(more?.steps?.at(-1)?.id).toBe('u450')
    expect(more?.steps?.[0]?.id).toBe('u1')

    // Absurd values are clamped rather than honoured (server-side ceiling).
    expect((await at(Number.MAX_SAFE_INTEGER))?.steps).toHaveLength(450)
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
    // 4 records, 2 turns: [a2 → u3 → a4] (a2 is the prelude of u3's request) and [u5].
    expect(segment?.title).toBe('+2 轮')
    expect(segment?.collapsedCount).toBe(2)
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

describe('turnSteps', () => {
  const node = (id: string, overrides: Partial<SessionTreeNode> = {}): SessionTreeNode => ({
    id,
    parentId: null,
    kind: 'message',
    sessionKey: 's',
    type: 'message',
    title: id,
    childCount: 0,
    isLeaf: false,
    isHead: false,
    ...overrides,
  })

  it('folds thinking, tool calls, telemetry and the reply into one user turn', () => {
    const turns = turnSteps([
      node('u1', { role: 'user', preview: '帮我改一下 dashboard' }),
      node('sys1', { kind: 'system', role: 'system', title: 'Thinking → max' }),
      node('t1', { kind: 'tool', role: 'assistant', title: 'Assistant · Read', tools: ['Read'], preview: '正在读文件' }),
      node('tel1', { kind: 'custom', role: 'system', title: 'compact-thinking-duration' }),
      node('tel2', { kind: 'custom', role: 'system', title: 'compact-thinking-duration' }),
      node('a1', { role: 'assistant', preview: '改好了，喵' }),
      node('u2', { role: 'user', preview: '再帮我看看测试' }),
      node('a2', { role: 'assistant', preview: '测试通过' }),
    ])

    // 8 records -> 2 turns, and the noise is gone from the step list.
    expect(turns.map(turn => turn.id)).toEqual(['u1', 'u2'])
    expect(turns[0]).toMatchObject({
      type: 'turn',
      role: 'user',
      title: 'User',
      preview: '帮我改一下 dashboard',
      reply: '改好了，喵',
      coveredCount: 6,
    })
    expect(turns[0].tools).toEqual(['Read'])
    expect(turns[1]).toMatchObject({ reply: '测试通过', coveredCount: 2 })
  })

  it('keeps a model/thinking prelude inside the turn it set up', () => {
    // The graph's first card is usually `Model → ...`; it is setup for the first
    // request, not a step the reader has to click through.
    const turns = turnSteps([
      node('m1', { kind: 'system', role: 'system', title: 'Model → deepseek' }),
      node('th1', { kind: 'system', role: 'system', title: 'Thinking → max' }),
      node('u1', { role: 'user', preview: 'hello' }),
      node('a1', { role: 'assistant', preview: '喵，你好' }),
      node('u2', { role: 'user', preview: '再问一个' }),
      node('a2', { role: 'assistant', preview: '好' }),
    ])
    expect(turns.map(turn => turn.id)).toEqual(['u1', 'u2'])
    expect(turns[0]).toMatchObject({ title: 'User', preview: 'hello', reply: '喵，你好', coveredCount: 4 })
  })

  it('opens a new turn at a compaction (a context reset is its own step)', () => {
    const turns = turnSteps([
      node('u1', { role: 'user', preview: '继续' }),
      node('a1', { role: 'assistant', preview: '好' }),
      node('c1', { kind: 'compaction', role: 'system', title: 'Compaction', preview: '摘要' }),
      node('a2', { role: 'assistant', preview: '压缩后继续' }),
    ])
    expect(turns.map(turn => turn.id)).toEqual(['u1', 'c1'])
    expect(turns[1]).toMatchObject({ coveredCount: 2, preview: '摘要', reply: '压缩后继续' })
  })

  it('keeps a user turn whose reply is missing (still one step)', () => {
    const turns = turnSteps([node('u1', { role: 'user', preview: '还没回' })])
    expect(turns).toHaveLength(1)
    expect(turns[0].id).toBe('u1')
    expect(turns[0].reply).toBeUndefined()
  })

  it('falls back to the assistant text when a run has no user message', () => {
    const turns = turnSteps([
      node('a1', { role: 'assistant', preview: '第一段' }),
      node('t1', { kind: 'tool', role: 'assistant', tools: ['Bash'], title: 'Assistant · Bash' }),
      node('a2', { role: 'assistant', preview: '最终回答' }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ title: 'Assistant · Bash', preview: '第一段', reply: '最终回答', coveredCount: 3 })
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
    // Assistant-only records with no user message in between are ONE agent turn, even
    // though they are 8 records: the range still covers every one of them.
    expect(collapsed[0].collapsedCount).toBe(1)
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
describe('readSessionCompactions', () => {
  it('returns every compaction marker with the token count measured before it', async () => {
    const file = writeSession('compactions', [
      header('compactions-id'),
      user('u1', null),
      entry('compaction', 'c2', 'u1', { summary: 'first summary', tokensBefore: 165196 }),
      assistant('a3', 'c2'),
      entry('compaction', 'c4', 'a3', { summary: 'second summary', tokensBefore: 900 }),
    ])

    expect(await readSessionCompactions(file)).toEqual([
      { timestamp: TS, tokensBefore: 165196 },
      { timestamp: TS, tokensBefore: 900 },
    ])
  })

  it('ignores non-compaction entries and tolerates a missing token count', async () => {
    const file = writeSession('compactions-plain', [
      header('plain-id'),
      user('u1', null),
      entry('compaction', 'c2', 'u1', { summary: 'no usage recorded' }),
    ])

    expect(await readSessionCompactions(file)).toEqual([{ timestamp: TS }])
  })

  it('refuses session files outside the sessions directory', async () => {
    const outside = join(tmpdir(), `pi-outside-${process.pid}.jsonl`)
    writeFileSync(outside, `${header('outside-id')}\n`, 'utf8')
    try {
      await expect(readSessionCompactions(outside)).rejects.toMatchObject({ code: 'session_file_out_of_scope' })
    } finally {
      rmSync(outside, { force: true })
    }
  })
})
