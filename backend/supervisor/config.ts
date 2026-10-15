import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, realpath, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { SupervisorConfig } from '../../shared/src/supervisor.js'
import { SUPERVISOR_STANDARD_EVENT_TYPES, SUPERVISOR_SYSTEM_EVENT_TYPES } from '../../shared/src/supervisor.js'

export const eventTypePattern = /^[a-z][a-z0-9_-]{0,31}$/
/** Rejects empty, over-long, non-lowercase or reserved event categories before they reach storage. */
export function normalizeEventTypes(value: unknown): string[] | null {
  if (value === undefined || value === null) return [...SUPERVISOR_STANDARD_EVENT_TYPES]
  if (!Array.isArray(value) || value.length > 32) return null
  const types = [...new Set(value.map(item => (typeof item === 'string' ? item.trim() : '')))]
  if (types.some(item => !eventTypePattern.test(item) || SUPERVISOR_SYSTEM_EVENT_TYPES.includes(item))) return null
  return types.length ? types : [...SUPERVISOR_STANDARD_EVENT_TYPES]
}

export const supervisorRoot = path.join(os.homedir(), '.pi', 'dashboard', 'supervisor')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/**
 * The dashboard launcher script (`liveSessions.launch.command`, e.g. pi-clean) appends its own CLI
 * flags to every pane. With `--no-extensions` those flags must be provided by an explicitly loaded
 * extension, so the goal extension is part of the default isolation set: pi-clean passes
 * `--goal-continuation`, which pi would otherwise reject as an unknown option and exit immediately.
 */
export const goalExtensionPath = path.resolve(repo, '../pi-tsien-extension/packages/pi-tsien-goal/src/index.ts')
export const supervisorTools = ['supervisor_context', 'event_objects', 'event_list', 'event_query', 'event_get', 'event_append', 'event_correct', 'supervisor_task_create', 'supervisor_task_update', 'supervisor_working_state', 'supervisor_action', 'supervisor_analyze', 'supervisor_report', 'supervisor_inspect', 'supervisor_coordinate']
export function normalizeSupervisorConfig(raw: unknown): SupervisorConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SupervisorConfig>
  const a = r.agentResources
  const strings = (value: unknown, defaults: string[] = []): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string' && !!s.trim()) : defaults
  return {
    enabled: r.enabled === true, cwd: typeof r.cwd === 'string' ? r.cwd : repo,
    pollIntervalMs: Math.max(60000, Number(r.pollIntervalMs) || 120000),
    staleAfterMs: Math.max(60000, Number(r.staleAfterMs) || 900000),
    allowedObjects: strings(r.allowedObjects), allowedSessionIds: strings(r.allowedSessionIds), allowedRoots: strings(r.allowedRoots),
    eventTypes: normalizeEventTypes((r as { eventTypes?: unknown }).eventTypes) ?? [...SUPERVISOR_STANDARD_EVENT_TYPES],
    agentResources: {
      rolePath: a?.rolePath || path.join(repo, 'agent/supervisor/role.md'),
      skillPaths: strings(a?.skillPaths, [path.join(repo, 'agent/supervisor/skills/dashboard-supervisor')]),
      extensionPaths: strings(a?.extensionPaths, [path.resolve(repo, '../pi-tsien-extension/extensions/supervisor/index.ts'), path.resolve(repo, '../pi-tsien-extension/packages/pi-tsien-live-session/src/index.ts'), goalExtensionPath]),
      allowedTools: strings(a?.allowedTools, supervisorTools), mode: a?.mode === 'coordinate' ? 'coordinate' : 'observe',
    },
  }
}

/**
 * Persisted supervisor config drops the resource paths that already equal the derived defaults.
 * Those defaults resolve from the dashboard repo location (and its sibling `pi-tsien-extension`), so
 * echoing them back into `~/.pi/dashboard.json` would freeze machine-specific absolute paths into the
 * config file and silently break the next time either repo moves.
 */
export function minimalSupervisorConfig(config: SupervisorConfig): Partial<SupervisorConfig> {
  const defaults = normalizeSupervisorConfig({})
  const sameList = (left: string[], right: string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index])
  const persisted: Record<string, unknown> = { ...config }
  if (config.cwd === defaults.cwd) delete persisted.cwd
  const resources: Record<string, unknown> = { ...config.agentResources }
  if (config.agentResources.rolePath === defaults.agentResources.rolePath) delete resources.rolePath
  if (sameList(config.agentResources.skillPaths, defaults.agentResources.skillPaths)) delete resources.skillPaths
  if (sameList(config.agentResources.extensionPaths, defaults.agentResources.extensionPaths)) delete resources.extensionPaths
  persisted.agentResources = resources
  return persisted as Partial<SupervisorConfig>
}

async function fingerprint(root: string): Promise<string> {
  const info = await stat(root)
  if (info.isFile()) return (await readFile(root)).toString('base64')
  if (!info.isDirectory()) throw new Error('unsupported_resource')
  const names = (await readdir(root)).sort()
  const parts: string[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const file = path.join(root, name)
    const canonical = await realpath(file)
    if (!canonical.startsWith(root + path.sep)) throw new Error('resource_symlink_outside_root')
    parts.push(name, await fingerprint(canonical))
  }
  return parts.join('\n')
}
export async function validateSupervisorResources(config: SupervisorConfig): Promise<{ revision: string; extensionsRevision: string; role: string; args: string[] }> {
  if (!path.isAbsolute(config.cwd)) throw new Error('absolute_cwd_required')
  const cwd = await stat(await realpath(config.cwd))
  if (!cwd.isDirectory()) throw new Error('invalid_supervisor_cwd')
  if (!config.agentResources.skillPaths.length || !config.agentResources.extensionPaths.length) throw new Error('supervisor_resources_required')
  const resources = [config.agentResources.rolePath, ...config.agentResources.skillPaths, ...config.agentResources.extensionPaths]
  const canonical: string[] = []
  // Gating fingerprint: what the running session is allowed to do. Extension sources are hashed separately
  // (extensionsRevision) because pi-tsien-extension is developed continuously; an edited extension must not
  // pause a healthy main session, it only warrants a "restart to pick up new code" notice.
  const gatingContent: string[] = []
  const extensionCanonical: string[] = []
  const extensionContent: string[] = []
  for (const p of resources) {
    if (!path.isAbsolute(p)) throw new Error('absolute_resource_path_required')
    const resolved = await realpath(p)
    if (canonical.includes(resolved)) throw new Error('duplicate_resource')
    canonical.push(resolved)
    const content = await fingerprint(resolved)
    if (p === config.agentResources.rolePath || config.agentResources.skillPaths.includes(p)) gatingContent.push(content)
    else { extensionCanonical.push(resolved); extensionContent.push(content) }
  }
  for (const p of config.agentResources.skillPaths) {
    const text = await readFile(path.join(p, 'SKILL.md'), 'utf8')
    const metadata = text.match(/^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    if (!metadata || !/^name:[^\S\r\n]*\S.+$/m.test(metadata) || !/^description:[^\S\r\n]*\S.+$/m.test(metadata)) throw new Error('invalid_skill_metadata')
  }
  if (!config.agentResources.allowedTools.length || config.agentResources.allowedTools.some(t => !supervisorTools.includes(t))) throw new Error('invalid_supervisor_tool_allowlist')
  const role = await readFile(config.agentResources.rolePath, 'utf8')
  const skills = await Promise.all(config.agentResources.skillPaths.map(p => readFile(path.join(p, 'SKILL.md'), 'utf8')))
  const revision = createHash('sha256').update(JSON.stringify(config)).update(canonical.join('\n')).update(gatingContent.join('\n')).digest('hex')
  const extensionsRevision = createHash('sha256').update(extensionCanonical.join('\n')).update(extensionContent.join('\n')).digest('hex')
  return { revision, extensionsRevision, role, args: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-builtin-tools', '--system-prompt', role + '\n\n' + skills.join('\n\n'), ...config.agentResources.skillPaths.flatMap(p => ['--skill', p]), ...config.agentResources.extensionPaths.flatMap(p => ['--extension', p])] }
}
