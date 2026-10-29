import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JiraStatusStore, jiraCategoryOf, type AcliRunner } from '../jira/status.js'
import { TaskService } from '../tasks/service.js'
import { PlanningStore } from '../tasks/planning-store.js'
import { HistoryStore } from '../tasks/history-store.js'
import type { TasksConfig } from '@shared/tasks.js'
import { mkdirSync, writeFileSync } from 'node:fs'

const CONFIG: TasksConfig = {
  enabled: true,
  journal: { autoDetect: false, roots: [], enabled: false },
  lanes: [],
  defaultView: 'execute',
}

/** Two keys: one still open, one already closed. Enough to prove mapping and drift inputs. */
const runner: AcliRunner = async keys => keys.map(key => ({
  key,
  status: key === 'PROJ-9' ? 'Done' : 'Development',
  category: key === 'PROJ-9' ? 'Done' : 'In Progress',
  assignee: 'Ada Lovelace',
  priority: 'Medium',
}))

describe('jira status cache', () => {
  it('maps Jira status categories to the three buckets the UI colours', () => {
    expect(jiraCategoryOf('Done')).toBe('done')
    expect(jiraCategoryOf('In Progress')).toBe('inprogress')
    expect(jiraCategoryOf('To Do')).toBe('todo')
    // A custom status name on its own is not guessed: the caller passes acli's `statusCategory.name`
    // alongside it (see the refresh test: name 'Development' + category 'In Progress' → inprogress).
    expect(jiraCategoryOf('Development')).toBe('unknown')
    expect(jiraCategoryOf('')).toBe('unknown')
  })

  it('peeks the cache without calling acli, and refresh fills it from a single batched read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-'))
    const file = join(dir, 'jira-status.json')
    try {
      const store = new JiraStatusStore(file, runner)
      const empty = await store.peek(['PROJ-1'])
      expect(empty.statuses).toEqual({})
      expect(empty.meta.stale).toBe(true)

      const refreshed = await store.refresh(['PROJ-1', 'PROJ-9', 'not-a-key', 'TASK-x'])
      expect(Object.keys(refreshed.statuses).sort()).toEqual(['PROJ-1', 'PROJ-9'])
      expect(refreshed.statuses['PROJ-1']).toMatchObject({ name: 'Development', category: 'inprogress', assignee: 'Ada Lovelace', priority: 'Medium' })
      expect(refreshed.statuses['PROJ-9']).toMatchObject({ name: 'Done', category: 'done' })
      expect(refreshed.meta).toMatchObject({ available: true, stale: false })
      expect(refreshed.meta.readAt).toBeTruthy()

      // 0600 like the other local state files.
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(file, 'utf8')).statuses['PROJ-9'].category).toBe('done')

      const peeking = await new JiraStatusStore(file, async () => { throw new Error('must not run') }).peek(['PROJ-1', 'PROJ-9'])
      expect(peeking.statuses['PROJ-1']?.name).toBe('Development')
      expect(peeking.meta.stale).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to the old cache when acli is missing, and keeps the reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jira-'))
    const file = join(dir, 'jira-status.json')
    try {
      const good = new JiraStatusStore(file, runner)
      await good.refresh(['PROJ-1'])
      const broken = new JiraStatusStore(file, async () => { throw new Error('acli_not_found') })
      const result = await broken.refresh(['PROJ-1', 'PROJ-9'])
      expect(result.meta.error).toBe('acli_not_found')
      expect(result.statuses['PROJ-1']?.name).toBe('Development')
      expect(result.statuses['PROJ-9']).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('task service · jira status and hierarchy', () => {
  function journal(): string {
    const root = mkdtempSync(join(tmpdir(), 'jira-journal-'))
    const taskDir = join(root, 'tasks', 'ocr', 'PROJ-1-epic', 'PROJ-2-task')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(root, 'tasks', 'DOMAINS.yaml'), 'schema_version: 1\ndomains:\n  - key: ocr\n    title: OCR\n')
    writeFileSync(join(root, 'tasks', 'ocr', 'epic.yaml'), [
      'schema_version: 1',
      'epics:',
      '  - key: PROJ-1',
      "    title: 'Tracked epic'",
      '    status: active',
      '    path: tasks/ocr/PROJ-1-epic',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'tasks', 'ocr', 'PROJ-1-epic', 'task.yaml'), [
      'schema_version: 1',
      'tasks:',
      '  - key: PROJ-9',
      "    title: 'Closed child'",
      '    status: done',
      '    path: tasks/ocr/PROJ-1-epic/PROJ-2-task',
      '  - key: proj-local',
      "    title: 'Open child'",
      '    status: in_progress',
      '    path: tasks/ocr/PROJ-1-epic/PROJ-2-task',
      '',
    ].join('\n'))
    writeFileSync(join(taskDir, 'stage-dag.yaml'), [
      'active_stage: stage_2_pull',
      'updated: 2026-10-20',
      'stages:',
      '  - id: stage_0_planning',
      '    status: done',
      '  - id: stage_1_taxonomy',
      '    status: done',
      '  - id: stage_2_pull',
      '    status: executing',
      '  - id: stage_3_landing',
      '    status: pending',
      '',
    ].join('\n'))
    return root
  }

  it('refreshes only open tickets, keeps archived and finished ones out of the acli call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jira-scope-'))
    const dir = mkdtempSync(join(tmpdir(), 'jira-scope-cache-'))
    try {
      mkdirSync(join(root, 'tasks', 'ocr', 'PROJ-1-epic'), { recursive: true })
      mkdirSync(join(root, 'tasks', 'ocr', '_archive', 'OLD-1-epic'), { recursive: true })
      writeFileSync(join(root, 'tasks', 'DOMAINS.yaml'), 'schema_version: 1\ndomains:\n  - key: ocr\n    title: OCR\n')
      writeFileSync(join(root, 'tasks', 'ocr', 'epic.yaml'), [
        'schema_version: 1',
        'epics:',
        '  - key: PROJ-1',
        "    title: 'Live epic'",
        '    status: active',
        '    path: tasks/ocr/PROJ-1-epic',
        '  - key: OLD-1',
        "    title: 'Archived epic'",
        '    status: archived',
        '    path: tasks/ocr/_archive/OLD-1-epic',
        '',
      ].join('\n'))
      writeFileSync(join(root, 'tasks', 'ocr', 'PROJ-1-epic', 'task.yaml'), [
        'schema_version: 1',
        'tasks:',
        '  - key: PROJ-9',
        "    title: 'Finished child'",
        '    status: done',
        '  - key: PROJ-8',
        "    title: 'Open child'",
        '    status: in_progress',
        '',
      ].join('\n'))
      writeFileSync(join(root, 'tasks', 'ocr', '_archive', 'OLD-1-epic', 'task.yaml'), [
        'schema_version: 1',
        'tasks:',
        '  - key: OLD-9',
        "    title: 'History'",
        '    status: in_progress',
        '',
      ].join('\n'))

      const asked: string[][] = []
      const store = new JiraStatusStore(join(dir, 'jira.json'), async keys => {
        asked.push([...keys])
        return keys.map(key => ({ key, status: 'Development', category: 'In Progress' }))
      })
      const service = new TaskService({
        getConfig: () => ({ ...CONFIG, journal: { autoDetect: false, roots: [root], enabled: true } }),
        listLiveSessions: () => [],
        planningStore: new PlanningStore(join(dir, 'planning.json')),
        historyStore: new HistoryStore(join(dir, 'history.json')),
        jira: store,
      })

      // Pre-existing cache for the finished ticket must survive a refresh that skips it.
      await new JiraStatusStore(join(dir, 'jira.json'), async keys => keys.map(key => ({ key, status: 'Done', category: 'Done' }))).refresh(['PROJ-9'])

      const result = await service.refreshJira()
      // Open tickets are read (the active epic's own ticket counts); the finished child and the
      // archived epic's child are skipped, so the acli call stays about half its old size.
      expect(asked).toEqual([['PROJ-1', 'PROJ-8']])
      // The archived epic itself + its child both count as archived.
      expect(result.scope).toEqual({ keys: 2, skippedDone: 1, skippedArchived: 2 })

      const snapshot = await service.snapshot()
      const byId = new Map(snapshot.tasks.map(task => [task.id, task]))
      expect(byId.get('PROJ-8')?.jiraStatus?.name).toBe('Development')
      // "Show what we already had": the skipped ticket keeps its old cached status.
      expect(byId.get('PROJ-9')?.jiraStatus?.name).toBe('Done')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls child completion into the epic, resolves the parent title, and attaches cached Jira state', async () => {
    const root = journal()
    const dir = mkdtempSync(join(tmpdir(), 'jira-svc-'))
    try {
      const store = new JiraStatusStore(join(dir, 'jira.json'), runner)
      await store.refresh(['PROJ-1', 'PROJ-9'])
      const service = new TaskService({
        getConfig: () => ({ ...CONFIG, journal: { autoDetect: false, roots: [root], enabled: true } }),
        listLiveSessions: () => [],
        planningStore: new PlanningStore(join(dir, 'planning.json')),
        historyStore: new HistoryStore(join(dir, 'history.json')),
        jira: store,
      })
      const res = await service.snapshot()
      const byUid = new Map(res.tasks.map(t => [t.uid, t]))

      // Epic rollup counts both children, not just the derived jira keys.
      expect(byUid.get('task-journal:PROJ-1')?.progress).toEqual({ done: 1, total: 2 })
      // Stage progress comes from stage-dag.yaml; `updated` gives the last-change date.
      expect(byUid.get('task-journal:PROJ-9')?.stage).toEqual({ done: 2, total: 4, active: 'stage_2_pull' })
      expect(byUid.get('task-journal:PROJ-9')?.updatedAt).toBe('2026-10-20')
      // Cached Jira state rides along, with the freshness metadata next to it.
      expect(byUid.get('task-journal:PROJ-1')?.jiraStatus).toMatchObject({ name: 'Development', category: 'inprogress' })
      expect(byUid.get('task-journal:PROJ-9')?.jiraStatus).toMatchObject({ name: 'Done', category: 'done' })
      expect(res.jira).toMatchObject({ available: true, stale: false })
      // A locally named task has no ticket, so no status and no link.
      expect(byUid.get('task-journal:proj-local')?.jiraStatus).toBeUndefined()
      expect(byUid.get('task-journal:proj-local')?.jiraUrl).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})