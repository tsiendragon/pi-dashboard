import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { TaskFact } from '@shared/tasks.js'
import type { TaskProvider } from '../types.js'
import { mapCompletion } from '../mapping.js'

interface EpicRecord { key?: string; title?: string; status?: string; path?: string }
interface TaskRecord { key?: string; title?: string; status?: string; path?: string; stages?: string[] }

async function readYaml(file: string): Promise<any | null> {
  try {
    return parseYaml(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Reads a "task journal" repo (a plain git checkout of dated markdown task files).
 * Nothing is hard-coded to a specific checkout:
 * any directory with `tasks/DOMAINS.yaml` + `tasks/<domain>/epic.yaml` +
 * `.../task.yaml` + `todos/*.md` works.
 *
 * Authority: the DOMAINS → epic.yaml → task.yaml tree. `active-status.yaml` is
 * intentionally ignored here (it duplicates the tree); it is only useful for
 * cross-checking in other tooling.
 *
 * Read-only. Facts mirror the journal; writes go through task-pilot.
 */
export class TaskJournalProvider implements TaskProvider {
  readonly type = 'task-journal'
  readonly capabilities = { writable: false, providesTodos: true, providesProgress: false }

  constructor(
    readonly root: string,
    readonly id: string = 'task-journal',
    readonly label: string = 'Task Journal',
  ) {}

  async available(): Promise<boolean> {
    return existsSync(join(this.root, 'tasks', 'DOMAINS.yaml'))
  }

  async list(): Promise<TaskFact[]> {
    const out: TaskFact[] = []
    const tasksRoot = join(this.root, 'tasks')
    const domains = (await readYaml(join(tasksRoot, 'DOMAINS.yaml')))?.domains
    const domainList: Array<{ key?: string }> = Array.isArray(domains) ? domains : []

    for (const domain of domainList) {
      const domainKey = String(domain?.key ?? '')
      if (!domainKey) continue
      const epics = (await readYaml(join(tasksRoot, domainKey, 'epic.yaml')))?.epics
      const epicList: EpicRecord[] = Array.isArray(epics) ? epics : []

      for (const epic of epicList) {
        const epicKey = String(epic?.key ?? '')
        if (!epicKey) continue
        const epicUid = `${this.id}:${epicKey}`
        const epicMap = mapCompletion(epic?.status)
        out.push({
          uid: epicUid,
          providerId: this.id,
          id: epicKey,
          kind: 'epic',
          title: String(epic?.title ?? epicKey),
          completion: epicMap.completion,
          ...(epicMap.completionRaw ? { completionRaw: epicMap.completionRaw } : {}),
          archived: String(epic?.status) === 'archived',
          plannable: true,
          path: epic?.path ? join(this.root, String(epic.path)) : undefined,
          tags: [domainKey],
          writable: false,
          sourceLabel: this.label,
          raw: epic,
        })

        if (!epic?.path) continue
        const taskFile = join(this.root, String(epic.path), 'task.yaml')
        if (!existsSync(taskFile)) continue
        const tasks = (await readYaml(taskFile))?.tasks
        const taskList: TaskRecord[] = Array.isArray(tasks) ? tasks : []
        for (const task of taskList) {
          const key = String(task?.key ?? '')
          if (!key) continue
          const mapped = mapCompletion(task?.status)
          out.push({
            uid: `${this.id}:${key}`,
            providerId: this.id,
            id: key,
            kind: 'task',
            parentUid: epicUid,
            parentTitle: String(epic?.title ?? epicKey),
            title: String(task?.title ?? key),
            completion: mapped.completion,
            ...(mapped.completionRaw ? { completionRaw: mapped.completionRaw } : {}),
            archived: false,
            plannable: true,
            path: task?.path ? join(this.root, String(task.path)) : undefined,
            tags: [domainKey],
            writable: false,
            sourceLabel: this.label,
            raw: task,
          })
        }
      }
    }

    out.push(...(await this.readTodos()))
    return out
  }

  /**
   * Cross-task todos from `todos/*.md`. These are free-form markdown with no
   * stable anchor ⇒ `plannable: false` (shown, never planned). Unparseable lines
   * degrade to plain entries; nothing is dropped.
   */
  private async readTodos(): Promise<TaskFact[]> {
    const dir = join(this.root, 'todos')
    if (!existsSync(dir)) return []
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.md'))
    } catch {
      return []
    }
    const out: TaskFact[] = []
    for (const file of files) {
      let text = ''
      try {
        text = await readFile(join(dir, file), 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)- \[( |x|X)\] (.*)$/.exec(lines[i])
        if (!m) continue
        const done = m[2].toLowerCase() === 'x'
        const title = m[3].replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim()
        let blocked = false
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\S/.test(lines[j]) || /^\s*- \[/.test(lines[j])) break
          if (/blocker/i.test(lines[j])) blocked = true
        }
        const fileBase = file.replace(/\.md$/, '')
        out.push({
          uid: `${this.id}:todo:${fileBase}:${i + 1}`,
          providerId: this.id,
          id: `${fileBase}:${i + 1}`,
          kind: 'todo',
          title: title || '(untitled)',
          completion: done ? 'done' : blocked ? 'paused' : 'todo',
          archived: false,
          plannable: false,
          tags: [fileBase],
          writable: false,
          sourceLabel: this.label,
          raw: { file: `todos/${file}`, line: i + 1, blocked },
        })
      }
    }
    return out
  }

  async get(id: string): Promise<TaskFact | null> {
    return (await this.list()).find(t => t.id === id) ?? null
  }
}
