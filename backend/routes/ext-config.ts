/**
 * Extension config routes — read/write the per-extension JSON files that live in the pi agent dir.
 *
 * Every pi extension keeps its settings in its own file (`<agent dir>/<name>.json`) and falls back to
 * built-in defaults when the file is missing. The dashboard never touches the filesystem directly:
 * this route exposes a strict whitelist so the Settings page (plugin `pi-extension-config`) can show
 * and tune them.
 *
 * Guards:
 *   - only whitelisted names; the resolved path must stay inside the agent dir (no traversal);
 *   - the body must be a plain JSON object;
 *   - writes are atomic (temp file + rename) so a crash cannot leave a half-written config.
 *
 * Not listed on purpose:
 *   - `theme.json` — an optional override file under `extensions/powerline-footer/`; creating an empty
 *     one is pointless, the built-in theme already applies;
 *   - `tsien-memory.json` / `rtk-config.json` — resolved per project (`<cwd>/.pi/...`), not per machine.
 */
import type { Express, Request, Response } from 'express'
import type { LiveSessionBrowserAuth } from '../live-sessions/auth.js'
import { requireBrowserAuth } from './require-browser-auth.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import os from 'os'

type FieldType = 'bool' | 'number' | 'string' | 'json'

interface FieldSpec {
  /** Dot path inside the config object, e.g. `observationPack.enabled`. */
  key: string
  type: FieldType
  label: string
  hint?: string
  options?: string[]
}

interface ConfigSpec {
  file: string
  description: string
  fields: FieldSpec[]
  /** Values written when the file does not exist yet (the extension's own defaults). */
  seed?: (agentDir: string) => Record<string, unknown>
}

const CONFIG_SPECS: Record<string, ConfigSpec> = {
  'bash-digest': {
    file: 'bash-digest.json',
    description: '大段 bash 输出在进上下文前交给便宜模型摘要；模型调用失败时静默回落原文',
    fields: [
      { key: 'enabled', type: 'bool', label: '启用' },
      { key: 'digestModel', type: 'string', label: '摘要模型', hint: 'provider/modelId，凭证来自 pi 自己的 provider 配置' },
      { key: 'thresholdBytes', type: 'number', label: '触发阈值（字节）' },
      { key: 'targetTokens', type: 'number', label: '目标摘要 token' },
      { key: 'maxTokens', type: 'number', label: '摘要输出上限' },
      { key: 'timeoutMs', type: 'number', label: '超时（毫秒）' },
      { key: 'maxConcurrent', type: 'number', label: '并发上限' },
      { key: 'excludePatterns', type: 'json', label: '排除的命令正则（数组）', hint: '列出条目类命令不应摘要，丢行就是丢事实' },
    ],
    seed: () => ({
      enabled: false,
      thresholdBytes: 1200,
      targetTokens: 40,
      maxTokens: 128,
      timeoutMs: 6000,
      maxConcurrent: 2,
      digestModel: 'dashscope/qwen3.8-flash',
      codeDumpRatio: 0.3,
      maxDigestRatio: 0.6,
    }),
  },
  'observation-pack': {
    file: 'observation-pack.json',
    description: '大工具结果落盘归档，上下文里只留占位符 + obs id，可用 obs_recall 取回',
    fields: [
      { key: 'observationPack.enabled', type: 'bool', label: '启用' },
      { key: 'observationPack.archiveDir', type: 'string', label: '归档目录', hint: '可用 PI_OBSERVATION_DIR 覆盖' },
      { key: 'observationPack.thresholdBytes', type: 'number', label: '触发阈值（字节）' },
      { key: 'observationPack.fullSends', type: 'number', label: '起始原样返回次数' },
      { key: 'observationPack.placeholderExcerptBytes', type: 'number', label: '占位符保留字节' },
      { key: 'observationPack.recallMaxBytes', type: 'number', label: 'obs_recall 单次上限字节' },
      { key: 'observationPack.recallMaxLines', type: 'number', label: 'obs_recall 单次上限行数' },
      { key: 'observationPack.cleanupEnabled', type: 'bool', label: '启用清理' },
      { key: 'observationPack.retentionDays', type: 'number', label: '保留天数' },
    ],
    seed: (agentDir) => ({
      version: 1,
      observationPack: {
        enabled: true,
        archiveDir: join(agentDir, 'archiv'),
        thresholdBytes: 10240,
        fullSends: 2,
        placeholderExcerptBytes: 1024,
        recallMaxBytes: 16384,
        recallMaxLines: 400,
        cleanupEnabled: false,
        retentionDays: 30,
      },
    }),
  },
  'large-read-pack': {
    file: 'large-read-pack.json',
    description: '把过大的 read 结果换成头尾 + obs id（实测偏贵，默认关闭；需 observation-pack 打开）',
    fields: [
      { key: 'enabled', type: 'bool', label: '启用' },
      { key: 'thresholdBytes', type: 'number', label: '触发阈值（字节）' },
      { key: 'headBytes', type: 'number', label: '保留头部字节' },
      { key: 'tailBytes', type: 'number', label: '保留尾部字节' },
      { key: 'minSavedRatio', type: 'number', label: '最小节省比例' },
    ],
    seed: () => ({
      enabled: false,
      thresholdBytes: 8192,
      headBytes: 6144,
      tailBytes: 1500,
      minSavedRatio: 0.5,
    }),
  },
  'auto-compact-target': {
    file: 'auto-compact-target.json',
    description: '统一压缩触发点到 min(targetTokens, windowRatio × contextWindow)',
    fields: [
      { key: 'enabled', type: 'bool', label: '启用' },
      { key: 'targetTokens', type: 'number', label: '目标 token 上限' },
      { key: 'windowRatio', type: 'number', label: '窗口比例', hint: '0.75 表示窗口的 75%' },
      { key: 'modelOverrides', type: 'json', label: '按模型覆盖（对象）' },
    ],
    seed: () => ({ enabled: true, targetTokens: 270000, windowRatio: 0.75, modelOverrides: {} }),
  },
  'compact-thinking': {
    file: 'compact-thinking.json',
    description: 'compact 后 thinking 标题与预览行的显示方式',
    fields: [
      { key: 'useSummaryTitlesAsThinkingTitle', type: 'bool', label: '用摘要标题当 thinking 标题' },
      { key: 'previewLines', type: 'number', label: '预览行数' },
      { key: 'animationIntervalMs', type: 'number', label: '动画间隔（毫秒）' },
    ],
    seed: () => ({
      useSummaryTitlesAsThinkingTitle: true,
      previewLines: 3,
      animationIntervalMs: 90,
    }),
  },
  capability: {
    file: 'capability.json',
    description: 'capability 扩展的额外能力根目录（L2）',
    fields: [
      { key: 'roots', type: 'json', label: '额外根目录（字符串数组）', hint: '也可用 PI_CAPABILITY_ROOTS 传' },
    ],
    seed: () => ({ roots: [] }),
  },
  'claude-code-style': {
    file: 'claude-code-style.json',
    description: 'Claude Code 风格的工具渲染与 diff 展示',
    fields: [
      { key: 'mode', type: 'string', label: '模式', options: ['on', 'off'] },
      { key: 'useSummaryTitlesAsThinkingTitle', type: 'bool', label: '用摘要标题当 thinking 标题' },
      { key: 'previewLines', type: 'number', label: '预览行数' },
      { key: 'animationIntervalMs', type: 'number', label: '动画间隔（毫秒）' },
      { key: 'excludeRenderers', type: 'json', label: '排除的渲染器（数组）' },
    ],
    seed: () => ({
      mode: 'on',
      excludeRenderers: [],
      useSummaryTitlesAsThinkingTitle: true,
      previewLines: 3,
      animationIntervalMs: 90,
    }),
  },
}

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  return configured ? resolve(configured) : join(os.homedir(), '.pi', 'agent')
}

/** Resolve a whitelisted config file, refusing anything that escapes the agent dir. */
function configPath(spec: ConfigSpec): string {
  const root = agentDir()
  const path = resolve(root, spec.file)
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`refusing to touch a path outside the agent dir: ${path}`)
  }
  return path
}

function readConfig(spec: ConfigSpec): unknown | undefined {
  const path = configPath(spec)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

export function registerExtConfigRoutes(options: { app: Express; auth: LiveSessionBrowserAuth }): void {
  const { app, auth } = options
  // Writing config files is a machine-state change; reads stay open like the other read APIs.
  const requireAuth = requireBrowserAuth(auth)

  app.get('/api/ext/config', (_req: Request, res: Response) => {
    const dir = agentDir()
    res.json({
      agentDir: dir,
      configs: Object.entries(CONFIG_SPECS).map(([name, spec]) => {
        const path = configPath(spec)
        const content = readConfig(spec)
        return {
          name,
          file: spec.file,
          description: spec.description,
          fields: spec.fields,
          path,
          exists: existsSync(path),
          readable: content !== undefined,
          content: content ?? null,
          seed: spec.seed ? spec.seed(dir) : null,
        }
      }),
    })
  })

  app.put('/api/ext/config/:name', requireAuth, (req: Request, res: Response) => {
    const raw = req.params.name as string | string[] | undefined
    const name = Array.isArray(raw) ? raw[0] : raw
    if (!name || !Object.prototype.hasOwnProperty.call(CONFIG_SPECS, name)) {
      res.status(400).json({ error: `unknown extension config: ${String(name)}` })
      return
    }
    const spec = CONFIG_SPECS[name]
    const body = req.body as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' })
      return
    }
    const path = configPath(spec)
    const tmp = `${path}.tmp-${process.pid}`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
      renameSync(tmp, path)
      res.json({ ok: true, name, path, bytes: JSON.stringify(body).length })
    } catch (error) {
      try {
        if (existsSync(tmp)) writeFileSync(tmp, '')
      } catch {
        /* best effort cleanup; the rename below is what matters */
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}