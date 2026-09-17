import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskJournalProvider } from '../tasks/providers/task-journal.js'
import { LocalTaskProvider } from '../tasks/providers/local.js'
import { TaskService } from '../tasks/service.js'
import { PlanningStore } from '../tasks/planning-store.js'
import { HistoryStore } from '../tasks/history-store.js'
import { ExternalTaskProvider } from '../tasks/providers/external.js'
import { linkSessions } from '../tasks/session-linker.js'
import type { TaskFact, TasksConfig } from '@shared/tasks.js'

const CONFIG: TasksConfig = {
  enabled: true,
  journal: { autoDetect: true, roots: [], enabled: true },
  lanes: [
    { id: 'long', label: '长期', match: { kind: ['epic'] } },
    { id: 'short', label: '短期', match: { kind: ['task'] } },
    { id: 'adhoc', label: '临时', match: { kind: ['todo', 'item'] } },
  ],
  defaultView: 'execute',
}

function makeJournal(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-'))
  mkdirSync(join(root, 'tasks', 'ocr', 'RISKY-1-epic', 'RISKY-2-task'), { recursive: true })
  mkdirSync(join(root, 'todos'), { recursive: true })
  writeFileSync(join(root, 'tasks', 'DOMAINS.yaml'), 'schema_version: 1\ndomains:\n  - key: ocr\n    title: OCR\n')
  writeFileSync(join(root, 'tasks', 'ocr', 'epic.yaml'), [
    'schema_version: 1',
    'domain: ocr',
    'epics:',
    "  - key: RISKY-1",
    "    title: 'Active epic'",
    '    status: active',
    '    path: tasks/ocr/RISKY-1-epic',
    "  - key: RISKY-0",
    "    title: 'Archived epic'",
    '    status: archived',
    '    path: tasks/ocr/_archive/RISKY-0-epic',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'tasks', 'ocr', 'RISKY-1-epic', 'task.yaml'), [
    'schema_version: 1',
    'epic: RISKY-1',
    'tasks:',
    '  - key: RISKY-2',
    '    title: Doing thing',
    '    status: in_progress',
    '    path: tasks/ocr/RISKY-1-epic/RISKY-2-task',
    '  - key: RISKY-3',
    '    title: Weird status',
    '    status: Feasibility',
    '    path: tasks/ocr/RISKY-1-epic/RISKY-2-task',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'todos', 'followups.md'), '# Follow-ups\n\n- [ ] **Open item**\n  - blocker: key missing\n- [x] **Done item**\n')
  return root
}

describe('task-journal provider', () => {
  it('maps tree facts, ignores active-status, keeps raw status, marks todos unplannable', async () => {
    const root = makeJournal()
    try {
      const provider = new TaskJournalProvider(root, 'task-journal', 'Journal')
      const tasks = await provider.list()
      const byId = new Map(tasks.map(t => [t.id, t]))

      expect(byId.get('RISKY-1')?.kind).toBe('epic')
      expect(byId.get('RISKY-1')?.completion).toBe('doing')
      expect(byId.get('RISKY-0')?.archived).toBe(true)

      const task2 = byId.get('RISKY-2')
      expect(task2?.kind).toBe('task')
      expect(task2?.completion).toBe('doing')
      expect(task2?.parentUid).toBe('task-journal:RISKY-1')
      expect(task2?.path).toBe(join(root, 'tasks/ocr/RISKY-1-epic/RISKY-2-task'))
      expect(task2?.plannable).toBe(true)

      const weird = byId.get('RISKY-3')
      expect(weird?.completion).toBe('todo')
      expect(weird?.completionRaw).toBe('Feasibility')

      const todos = tasks.filter(t => t.kind === 'todo')
      expect(todos).toHaveLength(2)
      expect(todos.every(t => t.plannable === false)).toBe(true)
      expect(todos.find(t => t.title.includes('Open'))?.completion).toBe('paused')
      expect(todos.find(t => t.title.includes('Done'))?.completion).toBe('done')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('local provider', () => {
  it('reads local tasks and keeps stable identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-'))
    const file = join(dir, 'tasks.json')
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: 't-1', title: 'Local', status: 'done' }] }))
    try {
      const tasks = await new LocalTaskProvider(file, 'local', 'Local').list()
      expect(tasks).toHaveLength(1)
      expect(tasks[0].uid).toBe('local:t-1')
      expect(tasks[0].completion).toBe('done')
      expect(tasks[0].plannable).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('local CRUD', () => {
  it('create / update / delete round-trips and stays isolated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localcrud-'))
    const file = join(dir, 'tasks.json')
    const provider = new LocalTaskProvider(file, 'local', 'Local')
    const created = await provider.createTask({ title: 'Ask Bob for GT' })
    expect(created.id).toMatch(/^t-/)
    expect(created.completion).toBe('todo')
    expect(created.plannable).toBe(true)

    const updated = await provider.updateTask(created.id, { status: 'doing', description: 'waiting on Bob' })
    expect(updated?.completion).toBe('doing')
    expect(updated?.description).toBe('waiting on Bob')

    expect(await provider.list()).toHaveLength(1)
    expect(await provider.deleteTask(created.id)).toBe(true)
    expect(await provider.list()).toHaveLength(0)
  })
})

describe('TaskService write guards', () => {
  it('rejects writes to a read-only journal source', async () => {
    const root = makeJournal()
    const planningPath = join(mkdtempSync(join(tmpdir(), 'plan-')), 'planning.json')
    try {
      const service = new TaskService({
        getConfig: () => ({ ...CONFIG, journal: { autoDetect: false, roots: [root], enabled: true } }),
        listLiveSessions: () => [],
        planningStore: new PlanningStore(planningPath),
      })
      await expect(service.updateTask('task-journal:RISKY-2', { title: 'x' })).rejects.toThrow('read_only_source')
      await expect(service.deleteTask('task-journal:RISKY-2')).rejects.toThrow('read_only_source')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('session linker', () => {
  const fact = (uid: string, path: string | undefined, id = uid): TaskFact => ({
    uid, providerId: 'p', id, kind: 'task', title: id, completion: 'doing',
    archived: false, plannable: true, path, tags: [], writable: false, sourceLabel: 'p',
  })

  it('attaches by longest cwd prefix (no double-attach), tag, and manual', () => {
    const tasks = [fact('p:EPIC', '/repo/tasks/ocr'), fact('p:TASK', '/repo/tasks/ocr/RISKY-1', 'RISKY-1')]
    const live = [
      { sessionId: 's1', processInstanceId: 'pr1', cwd: '/repo/tasks/ocr/RISKY-1/stage_1', title: 'deep', tags: [] },
      { sessionId: 's2', processInstanceId: 'pr2', cwd: '/repo/tasks/ocr/other', title: 'shallow', tags: [] },
    ]
    const refs = linkSessions(tasks, live, {})
    expect(refs['p:TASK']?.map(r => r.sessionId)).toEqual(['s1'])
    expect(refs['p:EPIC']?.map(r => r.sessionId)).toEqual(['s2'])

    const tagRefs = linkSessions(tasks, [{ sessionId: 's3', processInstanceId: 'pr3', cwd: '/elsewhere', title: 't', tags: ['risky-1'] }], {})
    expect(tagRefs['p:TASK']?.map(r => r.sessionId)).toEqual(['s3'])

    const manualRefs = linkSessions(tasks, live, { 'p:EPIC': ['s1', 'ghost'] })
    expect(manualRefs['p:EPIC']?.map(r => r.sessionId)).toEqual(['s2', 's1', 'ghost'])
    expect(manualRefs['p:EPIC']?.find(r => r.sessionId === 'ghost')?.live).toBe(false)
  })
})

describe('TaskService planning', () => {
  it('accepts plannable uids and rejects unstable ones', async () => {
    const root = makeJournal()
    const planningPath = join(mkdtempSync(join(tmpdir(), 'plan-')), 'planning.json')
    try {
      const service = new TaskService({
        getConfig: () => ({ ...CONFIG, journal: { autoDetect: false, roots: [root], enabled: true } }),
        listLiveSessions: () => [],
        planningStore: new PlanningStore(planningPath),
      })
      const res = await service.updatePlanning({ 'task-journal:RISKY-2': { pinned: true }, 'task-journal:todo:followups:3': { pinned: true } })
      expect(res.rejected).toEqual(['task-journal:todo:followups:3'])
      expect(res.overlay['task-journal:RISKY-2']?.pinned).toBe(true)
      expect(res.overlay['task-journal:todo:followups:3']).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('history store', () => {
  it('records one point per day, overwriting same-day changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist-'))
    const store = new HistoryStore(join(dir, 'history.json'))
    const base = { total: 3, todo: 1, doing: 2, done: 0, paused: 0, archived: 1 }
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const d1 = fmt(new Date(Date.now() - 86_400_000))
    const d2 = fmt(new Date())
    try {
      await store.record(base, d1)
      await store.record({ ...base, doing: 3, todo: 0 }, d1)
      await store.record({ ...base, total: 4 }, d2)
      const points = await store.series(30)
      expect(points.map(p => p.date)).toEqual([d1, d2])
      expect(points[0].doing).toBe(3)
      expect(points[1].total).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('service.snapshot records a snapshot exposed via historySeries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hist2-'))
    try {
      const service = new TaskService({
        getConfig: () => ({ ...CONFIG, journal: { autoDetect: false, roots: [], enabled: false } }),
        listLiveSessions: () => [],
        planningStore: new PlanningStore(join(dir, 'planning.json')),
        historyStore: new HistoryStore(join(dir, 'history.json')),
      })
      await service.snapshot()
      const points = await service.historySeries(30)
      expect(points.length).toBe(1)
      expect(points[0].total).toBe(points[0].todo + points[0].doing + points[0].done + points[0].paused)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('external provider (config-declared source)', () => {
  it('maps items from a JSON file and drops entries without id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-'))
    const file = join(dir, 'tasks.json')
    writeFileSync(file, JSON.stringify({ tasks: [
      { id: 'ABC-1', title: 'Fix bug', status: 'in_progress', tags: ['jira'], path: '/tmp/wd' },
      { title: 'no id — dropped' },
      { id: 'ABC-2', title: 'Old thing', status: 'done', archived: true },
    ] }))
    try {
      const p = new ExternalTaskProvider({ kind: 'file', id: 'jira', label: 'Jira', file })
      expect(await p.available()).toBe(true)
      const tasks = await p.list()
      expect(tasks.map(t => t.uid)).toEqual(['jira:ABC-1', 'jira:ABC-2'])
      expect(tasks[0].completion).toBe('doing')
      expect(tasks[0].writable).toBe(false)
      expect(tasks[0].tags).toEqual(['jira'])
      expect(tasks[1].archived).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads command stdout and keeps an unknown status as completionRaw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext2-'))
    const script = join(dir, 'emit.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify([{id:"L1",title:"Lark task",status:"Feasibility"}]))\n')
    try {
      const p = new ExternalTaskProvider({ kind: 'command', id: 'lark', label: 'Lark', command: ['node', script] })
      const tasks = await p.list()
      expect(tasks).toHaveLength(1)
      expect(tasks[0].uid).toBe('lark:L1')
      expect(tasks[0].completion).toBe('todo')
      expect(tasks[0].completionRaw).toBe('Feasibility')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a config-declared provider through TaskService', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext3-'))
    const file = join(dir, 't.json')
    writeFileSync(file, JSON.stringify([{ id: 'X1', title: 'Ext task', status: 'in_progress' }]))
    try {
      const service = new TaskService({
        getConfig: () => ({
          ...CONFIG,
          journal: { autoDetect: false, roots: [], enabled: false },
          providers: [{ kind: 'file', id: 'ext', label: 'Ext', file }],
        }),
        listLiveSessions: () => [],
        planningStore: new PlanningStore(join(dir, 'p.json')),
        historyStore: new HistoryStore(join(dir, 'h.json')),
      })
      const res = await service.snapshot()
      expect(res.providers.map(p => p.id)).toContain('ext')
      expect(res.tasks.find(t => t.uid === 'ext:X1')?.completion).toBe('doing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
