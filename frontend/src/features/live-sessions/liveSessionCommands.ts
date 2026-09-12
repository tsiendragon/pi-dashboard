/**
 * Live Session 斜杠命令菜单（仅用于 `/` 自动补全与提示文案）。
 *
 * 统一输入模型下，本模块不再把文本翻译成结构化命令：用户在 web 端输入的
 * 任何命令 / skill / 消息都原样走 `input` 文本流发给 Pi（与 TUI 逐字等价）。
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
  { command: '/compact', description: '压缩当前会话上下文，释放 token', insert: '/compact', kind: 'control' },
  { command: '/clear', description: '开启新的空会话（旧对话保留在文件中）', insert: '/clear', kind: 'control' },
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