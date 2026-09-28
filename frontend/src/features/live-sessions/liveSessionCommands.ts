/**
 * Live Session 斜杠命令菜单（仅用于 `/` 自动补全与提示文案）。
 *
 * pi 内置命令（/compact /reload /model）无法通过 input 文本流触发（内置命令由交互式
 * editor 分发），由 submit 翻译成结构化命令；**扩展注册的命令**（`/clear` 来自
 * `session-aliases.ts`，`/exit`、`/goal`、`/effort` 同理）与 skill 命令 / 普通消息则原样走
 * `input` 文本流发送给 Pi —— pi 只执行“已注册的扩展命令”，其余带 `/` 的文本会原样
 * 交给模型，所以这里列出的名字必须是真被注册过的。
 */

export interface LiveSessionSlashItem {
  command: string
  description: string
  /** 选中后插入输入框的文本 */
  insert: string
  kind: 'control' | 'lease' | 'tui'
}

/** 可在 web 端执行的命令（`/` 菜单的可用项）。 */
export const LIVE_SESSION_SLASH_MENU: LiveSessionSlashItem[] = [
  { command: '/compact', description: '压缩当前会话上下文，释放 token', insert: '/compact', kind: 'lease' },
  { command: '/clear', description: '开启新的空会话（旧对话保留在文件中）', insert: '/clear', kind: 'control' },
  { command: '/exit', description: '退出当前 Pi session', insert: '/exit', kind: 'control' },
  { command: '/abort', description: '中止当前正在执行的回答', insert: '/abort', kind: 'lease' },
  { command: '/reload', description: '重载扩展 / 技能 / 提示词 / 主题', insert: '/reload', kind: 'control' },
  { command: '/name', description: '设置会话名称', insert: '/name ', kind: 'control' },
  { command: '/model', description: '切换模型（provider/id）', insert: '/model ', kind: 'control' },
  { command: '/effort', description: '设置思考强度', insert: '/effort ', kind: 'control' },
]

/** 只在 TUI 终端里可用的交互式命令，web 端给提示、不发送。 */
export const LIVE_SESSION_TUI_ONLY: LiveSessionSlashItem[] = [
  { command: '/settings', description: '打开设置面板', insert: '', kind: 'tui' },
  { command: '/fork', description: '从历史消息分叉', insert: '', kind: 'tui' },
  { command: '/tree', description: '浏览会话树 / 切换分支', insert: '', kind: 'tui' },
  { command: '/resume', description: '切换会话', insert: '', kind: 'tui' },
  { command: '/import', description: '导入会话（JSONL）', insert: '', kind: 'tui' },
  { command: '/export', description: '导出会话（HTML / JSONL）', insert: '', kind: 'tui' },
  { command: '/share', description: '以 gist 分享会话', insert: '', kind: 'tui' },
  { command: '/copy', description: '复制最后一条回复', insert: '', kind: 'tui' },
  { command: '/hotkeys', description: '查看快捷键', insert: '', kind: 'tui' },
  { command: '/trust', description: '保存目录信任决策', insert: '', kind: 'tui' },
  { command: '/login', description: '配置 provider 认证', insert: '', kind: 'tui' },
  { command: '/logout', description: '移除 provider 认证', insert: '', kind: 'tui' },
  { command: '/quit', description: '退出 Pi', insert: '', kind: 'tui' },
]

/**
 * Whether this session can really clear.
 *
 * The bridge advertises `session_clear` only when `/clear` is present in pi's live
 * command registry — it comes from the `session-aliases` extension, not from pi, so
 * it disappears whenever that extension does not load (pi skips a missing extension
 * file silently). Sending `/clear` anyway would hand the text to the model: a click
 * that burns a turn and clears nothing, which is worse than an honest refusal.
 */
export function clearCommandAvailable(capabilities: readonly string[] | undefined): boolean {
  return capabilities?.includes('session_clear') === true
}
