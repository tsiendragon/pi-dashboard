import type { LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { refOf, type Catalog } from './catalog.js'
import type { DashboardClient } from './dashboardClient.js'
import type { Mapping } from './mapping.js'

export interface CommandContext {
  chatId: string
  threadId: string | null
  /** Id of the message that carried the command (topic anchor for replies). */
  messageId?: string
  catalog: Catalog
  mapping: Mapping
  dashboard: DashboardClient
}

const HELP = [
  '可用命令：',
  '/list              列出所有会话',
  '/bind <序号或名称>   绑定当前会话',
  '/switch <序号或名称> 同 /bind',
  '/new <cwd>          新建会话（稍后 /list 绑定）',
  '/unbind             解除绑定',
  '/status             查看当前绑定状态',
].join('\n')

/** Parse and execute a slash command. Returns the reply text. */
export async function handleCommand(text: string, ctx: CommandContext): Promise<string> {
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
    default:
      return `未知命令 /${name}\n\n${HELP}`
  }
}

function describe(summary: LiveSessionSummary, ctx: CommandContext): string {
  const bound = summary.sessionFile ? ctx.mapping.lookupsBySession(summary.sessionFile).length > 0 : false
  return `${refOf(summary)}  [${summary.status}]${bound ? ' ✓已绑定' : ''}\n   cwd=${summary.cwd}`
}

function listSessions(ctx: CommandContext): string {
  const sessions = ctx.catalog.list()
  if (!sessions.length) return '当前没有 live-session。'
  return [
    'Live sessions（用 /bind <序号或名称> 绑定）：',
    ...sessions.map((summary, index) => `${index + 1}. ${describe(summary, ctx)}`),
  ].join('\n')
}

async function bindSession(arg: string, ctx: CommandContext): Promise<string> {
  if (!arg) return '用法：/bind <序号或名称>；先用 /list 查看。'
  const target = ctx.catalog.resolve(arg)
  if (!target) return `未找到会话「${arg}」。用 /list 查看可用会话。`
  if (!target.sessionFile) return `会话「${refOf(target)}」缺少稳定的 sessionFile，无法绑定。`
  await ctx.mapping.bind(ctx.chatId, target.sessionFile, target.sessionName, ctx.threadId, ctx.messageId)
  return `已绑定到 ${refOf(target)}（${target.status}）。之后直接发消息即可。`
}

async function unbindSession(ctx: CommandContext): Promise<string> {
  const removed = await ctx.mapping.unbind(ctx.chatId, ctx.threadId)
  return removed ? '已解除绑定。' : '当前没有绑定。'
}

async function newSession(arg: string, ctx: CommandContext): Promise<string> {
  if (!arg) return '用法：/new <cwd>（新建会话需指定工作目录）。'
  const result = await ctx.dashboard.startSession(arg)
  return `已新建会话（sessionId=${result.sessionId ?? '?'}）。稍候用 /list 查看，再用 /bind 绑定。`
}

async function status(ctx: CommandContext): Promise<string> {
  const binding = ctx.mapping.lookupByChat(ctx.chatId, ctx.threadId)
  if (!binding) return '当前未绑定会话。用 /list 和 /bind 绑定。'
  const summary = ctx.catalog.resolveBinding(binding.sessionFile)
  const state = summary ? `在线（${summary.status}）` : '离线（会话已结束或未连接）'
  return `绑定：${binding.sessionName || binding.sessionFile}\n状态：${state}\ncwd：${summary?.cwd ?? '—'}`
}
