import { basename } from 'node:path'
import type { LiveSessionModelOption, LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import type { Catalog } from './catalog.js'
import { DashboardRequestError, type DashboardClient } from './dashboardClient.js'
import type { Binding, Mapping } from './mapping.js'

export interface CommandContext {
  chatId: string
  threadId: string | null
  /** Id of the message that carried the command (topic anchor for replies). */
  messageId?: string
  catalog: Catalog
  mapping: Mapping
  dashboard: DashboardClient
  /** Send an extra message before the final reply (used for long commands). */
  notify?: (text: string) => Promise<void>
}

/** Lease length for `compact` / `abort`: long enough for one command, short-lived. */
const LEASE_MS = 30_000
/** `/model` numbering is only meaningful against the list shown for this chat. */
const modelLists = new Map<string, { sessionFile: string; models: LiveSessionModelOption[] }>()

/** Test hook: forget cached `/model` lists. */
export function resetCommandState(): void {
  modelLists.clear()
}

const HELP = [
  '可用命令：',
  '/list                列出当前 dashboard 的在线会话',
  '/bind <序号或名称>     绑定当前会话（/switch 同义）',
  '/new <cwd>           新建会话',
  '/unbind              解除绑定',
  '/status              查看当前绑定状态',
  '/model               列出可用模型；/model <序号|provider/id|名称片段> 切换',
  '/compact             压缩当前会话上下文',
  '/abort               中断当前回合',
  '/context             查看上下文用量',
  '/reload              重载扩展 / 技能',
  '/name <新名称>        重命名会话',
  '/shutdown confirm    关闭会话（必须带 confirm）',
  '',
  '其它 /xxx（/clear、/goal、skill 命令等）会原样转给会话。',
].join('\n')

/**
 * Parse and execute a slash command.
 *
 * Returns `null` when the text is not a gateway command: those are forwarded to
 * the bound session as normal input, which is how pi's extension/skill commands
 * (`/clear`, `/goal`, …) keep working from Lark. TUI built-ins are translated
 * into structured commands first, because pi does not dispatch them from the
 * input text stream.
 */
export async function handleCommand(text: string, ctx: CommandContext): Promise<string | null> {
  const [name, ...rest] = text.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ').trim()
  switch (name) {
    case '':
    case 'help':
      return HELP
    case 'list':
      return listSessions(ctx)
    case 'bind':
    case 'switch':
      return bindSession(arg, ctx)
    case 'new':
      return newSession(arg, ctx)
    case 'unbind':
      return unbindSession(ctx)
    case 'status':
      return status(ctx)
    case 'model':
    case 'models':
      return modelCommand(arg, ctx)
    case 'compact':
      return compact(ctx)
    case 'abort':
    case 'stop':
      return abortTurn(ctx)
    case 'context':
    case 'ctx':
      return contextUsage(ctx)
    case 'reload':
    case 'restart':
      return reload(ctx)
    case 'name':
    case 'rename':
      return rename(arg, ctx)
    case 'shutdown':
      return shutdown(arg, ctx)
    default:
      return null
  }
}

function sessionLabel(summary: LiveSessionSummary): string {
  const name = summary.sessionName?.trim()
  if (name) return name
  const project = basename(summary.cwd.replace(/[\\/]+$/, ''))
  return project ? `${project} 项目会话` : `Pi 会话 ${summary.processInstanceId.slice(-6)}`
}

function statusLabel(status: LiveSessionSummary['status']): string {
  switch (status) {
    case 'running': return '正在运行'
    case 'reconnecting': return '重连中'
    default: return '空闲待命'
  }
}

function describe(summary: LiveSessionSummary, ctx: CommandContext): string {
  const project = basename(summary.cwd.replace(/[\\/]+$/, '')) || summary.cwd
  const currentBinding = ctx.mapping.lookup(ctx.chatId, ctx.threadId)
  const isBoundHere = currentBinding?.sessionFile === summary.sessionFile
  const isBoundElsewhere = summary.sessionFile
    ? ctx.mapping.lookupsBySession(summary.sessionFile).some(binding => binding.chatId !== ctx.chatId || binding.threadId !== ctx.threadId)
    : false
  const details = [
    ...(summary.sessionName?.trim() ? [`项目：${project}`] : []),
    ...(summary.git?.branch ? [`分支：${summary.git.branch}`] : []),
    `状态：${statusLabel(summary.status)}`,
    ...(summary.model ? [`模型：${summary.model.id}`] : []),
    isBoundHere ? '当前聊天已绑定' : isBoundElsewhere ? '已绑定到其他聊天' : '当前聊天未绑定',
  ]
  return `「${sessionLabel(summary)}」\n   ${details.join('；')}\n   工作目录：${summary.cwd}`
}

async function listSessions(ctx: CommandContext): Promise<string> {
  // A failed refresh still answers from cache, but it must say WHY: a silent
  // fallback once hid a dead dashboard channel for a full day.
  let staleReason = ''
  try {
    ctx.catalog.replace(await ctx.dashboard.listSessions())
  } catch (error) {
    staleReason = brief(error instanceof Error ? error.message : String(error))
    console.warn(`[gateway] /list refresh failed: ${staleReason}`)
  }
  const sessions = ctx.catalog.list()
  if (!sessions.length) {
    return staleReason
      ? `暂时无法读取 dashboard 的 live-session：${staleReason}`
      : '当前 dashboard 没有在线的 live-session。'
  }
  return [
    `当前 dashboard 有 ${sessions.length} 个在线会话${staleReason ? `（缓存列表，刷新失败：${staleReason}）` : ''}（用 /bind <序号> 绑定到当前聊天）：`,
    ...sessions.map((summary, index) => `${index + 1}. ${describe(summary, ctx)}`),
  ].join('\n')
}

/** Keep an error readable inside a chat bubble. */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

async function bindSession(arg: string, ctx: CommandContext): Promise<string> {
  if (!arg) return '用法：/bind <序号或名称>；先用 /list 查看。'
  const target = ctx.catalog.resolve(arg)
  if (!target) return `未找到会话「${arg}」。用 /list 查看可用会话。`
  if (!target.sessionFile) return `会话「${sessionLabel(target)}」缺少稳定的 sessionFile，无法绑定。`
  await ctx.mapping.bind(ctx.chatId, target.sessionFile, target.sessionName, ctx.threadId, ctx.messageId)
  // The numbered model list belongs to the session that was bound.
  modelLists.delete(scopeKey(ctx))
  return `已绑定到「${sessionLabel(target)}」（${statusLabel(target.status)}）。之后直接发消息即可。`
}

async function unbindSession(ctx: CommandContext): Promise<string> {
  const removed = await ctx.mapping.unbind(ctx.chatId, ctx.threadId)
  modelLists.delete(scopeKey(ctx))
  return removed ? '已解除绑定。' : '当前没有绑定。'
}

async function newSession(arg: string, ctx: CommandContext): Promise<string> {
  if (!arg) return '用法：/new <cwd>（新建会话需指定工作目录）。'
  const result = await ctx.dashboard.startSession(arg)
  return `已新建会话（sessionId=${result.sessionId ?? '?'}）。稍候用 /list 查看，再用 /bind 绑定。`
}

async function status(ctx: CommandContext): Promise<string> {
  const binding = ctx.mapping.lookup(ctx.chatId, ctx.threadId)
  if (!binding) return '当前未绑定会话。用 /list 和 /bind 绑定。'
  const summary = ctx.catalog.resolveBinding(binding.sessionFile)
  const state = summary ? `在线（${summary.status}）` : '离线（会话已结束或未连接）'
  const model = summary?.model ? `${summary.model.provider}/${summary.model.id}` : '—'
  return [
    `绑定：${summary ? sessionLabel(summary) : binding.sessionName || basename(binding.sessionFile)}`,
    `状态：${state}`,
    `作用域：${binding.threadId ? '仅本话题' : '整个聊天'}`,
    `模型：${model}`,
    `工作目录：${summary?.cwd ?? '—'}`,
  ].join('\n')
}

// --- session commands -------------------------------------------------------

function scopeKey(ctx: CommandContext): string {
  return ctx.threadId ? `${ctx.chatId}#${ctx.threadId}` : ctx.chatId
}

/** The bound session, or the message explaining why there is none. */
function bound(ctx: CommandContext): { binding: Binding; summary: LiveSessionSummary } | { error: string } {
  const binding = ctx.mapping.lookup(ctx.chatId, ctx.threadId)
  if (!binding) return { error: '当前未绑定会话。用 /list 查看，/bind <序号> 绑定。' }
  const summary = ctx.catalog.resolveBinding(binding.sessionFile)
  if (!summary) {
    return { error: `会话「${binding.sessionName || basename(binding.sessionFile)}」当前不可用，请 /list 后重新 /bind。` }
  }
  return { binding, summary }
}

function isDashboardError(error: unknown, check: (error: DashboardRequestError) => boolean): boolean {
  return error instanceof DashboardRequestError && check(error)
}

/**
 * Run `action` while holding the exclusive lease, then hand it straight back.
 * `compact` / `abort` are the only commands that require it; the lease is what
 * the web UI also uses, so the lock screen shows the bot as the owner for a
 * second or two.
 */
async function withLease(
  ctx: CommandContext,
  summary: LiveSessionSummary,
  action: (leaseId: string) => Promise<string>,
): Promise<string> {
  let leaseId: string
  try {
    leaseId = (await ctx.dashboard.claim(summary.processInstanceId, LEASE_MS)).leaseId
  } catch (error) {
    if (isDashboardError(error, failed => failed.status === 423 || failed.code === 'session_already_claimed')) {
      return '会话正被网页端接管（同一时刻只能一个客户端操作）。等半分钟或先在网页端放手后再试。'
    }
    throw error
  }
  try {
    return await action(leaseId)
  } catch (error) {
    if (isDashboardError(error, failed => failed.code === 'invalid_lease')) {
      return '接管已失效（可能被网页端抢占），请再发一次。'
    }
    if (isDashboardError(error, failed => failed.code === 'command_timeout' || failed.status === 504)) {
      // Dispatched, but the bridge took longer than the broker's 30s budget: a long
      // compaction keeps going after the timeout.
      return '命令已下发，但 30 秒内没等到完成（长会话压缩会更久）。稍后用 /context 看结果。'
    }
    throw error
  } finally {
    await ctx.dashboard.release(summary.processInstanceId, leaseId).catch(error => {
      console.warn(`[gateway] lease release failed: ${brief(error instanceof Error ? error.message : String(error))}`)
    })
  }
}

/** `1` (from the last `/model` list), `provider/id`, or a name fragment. */
function pickModel(arg: string, models: LiveSessionModelOption[]): { model: LiveSessionModelOption } | { error: string } {
  if (/^\d+$/.test(arg)) {
    const model = models[Number.parseInt(arg, 10) - 1]
    return model ? { model } : { error: `序号超范围：共 ${models.length} 个模型。先发 /model 看列表。` }
  }
  const needle = arg.toLowerCase()
  const entries = models.map(model => ({
    model,
    full: `${model.provider}/${model.id}`,
    haystack: `${model.provider}/${model.id} ${model.id} ${model.name}`.toLowerCase(),
  }))
  const exact = entries.filter(entry => entry.haystack.split(' ').includes(needle) || entry.full.toLowerCase() === needle)
  if (exact.length === 1) return { model: exact[0].model }
  const fuzzy = entries.filter(entry => entry.haystack.includes(needle))
  if (fuzzy.length === 1) return { model: fuzzy[0].model }
  if (fuzzy.length === 0) return { error: `没有匹配「${arg}」的模型。先发 /model 看列表。` }
  return {
    error: `「${arg}」匹配到 ${fuzzy.length} 个模型，请更具体：\n${fuzzy.slice(0, 8).map(entry => `  ${entry.full}`).join('\n')}`,
  }
}

async function modelList(ctx: CommandContext, summary: LiveSessionSummary, binding: Binding): Promise<LiveSessionModelOption[]> {
  const cached = modelLists.get(scopeKey(ctx))
  if (cached && cached.sessionFile === binding.sessionFile) return cached.models
  const models = await ctx.dashboard.models(summary.processInstanceId)
  modelLists.set(scopeKey(ctx), { sessionFile: binding.sessionFile, models })
  return models
}

async function modelCommand(arg: string, ctx: CommandContext): Promise<string> {
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { binding, summary } = target
  const current = summary.model ? `${summary.model.provider}/${summary.model.id}` : ''
  const models = await modelList(ctx, summary, binding)

  if (!arg) {
    if (models.length === 0) return `会话「${sessionLabel(summary)}」没有可切换的模型列表（旧版本扩展可能不支持）。`
    return [
      `会话「${sessionLabel(summary)}」当前模型：${current || '未知'}`,
      `用 /model <序号|provider/id|名称片段> 切换；共 ${models.length} 个：`,
      ...models.map((model, index) => {
        const full = `${model.provider}/${model.id}`
        const label = model.name && model.name !== model.id ? `（${model.name}）` : ''
        return `${index + 1}. ${full}${label}${full === current ? ' ← 当前' : ''}`
      }),
    ].join('\n')
  }

  const picked = pickModel(arg, models)
  if ('error' in picked) return picked.error
  await ctx.dashboard.command(summary.processInstanceId, {
    type: 'set_model',
    provider: picked.model.provider,
    modelId: picked.model.id,
  })
  return `已切换模型：${picked.model.provider}/${picked.model.id}（会话：${sessionLabel(summary)}）`
}

async function compact(ctx: CommandContext): Promise<string> {
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { summary } = target
  await ctx.notify?.(`正在压缩「${sessionLabel(summary)}」的上下文…（可能要十几秒）`)
  return withLease(ctx, summary, async leaseId => {
    await ctx.dashboard.command(summary.processInstanceId, { type: 'compact', leaseId })
    return `上下文压缩完成（会话：${sessionLabel(summary)}）。`
  })
}

async function abortTurn(ctx: CommandContext): Promise<string> {
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { summary } = target
  return withLease(ctx, summary, async leaseId => {
    await ctx.dashboard.command(summary.processInstanceId, { type: 'abort', leaseId })
    return `已请求中断「${sessionLabel(summary)}」当前的回合。`
  })
}

async function reload(ctx: CommandContext): Promise<string> {
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { summary } = target
  await ctx.dashboard.command(summary.processInstanceId, { type: 'reload' })
  return `已触发「${sessionLabel(summary)}」重载。扩展/技能/提示词改动现已生效。`
}

async function rename(arg: string, ctx: CommandContext): Promise<string> {
  if (!arg) return '用法：/name <新会话名>'
  if (arg.length > 160) return '会话名太长（最多 160 字）。'
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { summary } = target
  await ctx.dashboard.command(summary.processInstanceId, { type: 'set_session_name', name: arg })
  return `会话已改名为「${arg}」。`
}

async function shutdown(arg: string, ctx: CommandContext): Promise<string> {
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { summary } = target
  if (arg.toLowerCase() !== 'confirm') {
    return [
      `这会关闭「${sessionLabel(summary)}」：结束它正在跑的 Pi 进程，未落盘的工作会丢。`,
      '确认请发：/shutdown confirm',
    ].join('\n')
  }
  await ctx.dashboard.command(summary.processInstanceId, { type: 'shutdown' })
  return `已请求关闭「${sessionLabel(summary)}」。绑定仍然保留，用 /list 可重新绑定。`
}

interface ContextViewLike {
  source?: string
  format?: string
  model?: { provider?: string; id?: string }
  totals?: { tokens?: number }
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null }
}

async function contextUsage(ctx: CommandContext): Promise<string> {
  const target = bound(ctx)
  if ('error' in target) return target.error
  const { summary } = target
  const view = (await ctx.dashboard.command(summary.processInstanceId, { type: 'get_context' })) as ContextViewLike | undefined
  const tokens = typeof view?.totals?.tokens === 'number' ? view.totals.tokens : undefined
  const usage = view?.contextUsage
  const percent = typeof usage?.percent === 'number' ? `${usage.percent.toFixed(1)}%` : '—'
  const window = typeof usage?.contextWindow === 'number' ? formatNumber(usage.contextWindow) : '—'
  const model = view?.model?.provider && view?.model?.id ? `${view.model.provider}/${view.model.id}` : '—'
  return [
    `上下文（会话：${sessionLabel(summary)}）`,
    `估算 tokens：${tokens === undefined ? '—' : formatNumber(tokens)} · 窗口占用：${percent} / ${window}`,
    `模型：${model}${view?.source ? `（${view.source}${view.format ? `, ${view.format}` : ''}）` : ''}`,
  ].join('\n')
}

function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
