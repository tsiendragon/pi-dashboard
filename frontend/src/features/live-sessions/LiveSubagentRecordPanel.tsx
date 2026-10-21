import MarkdownRenderer from '../../components/MarkdownRenderer'
import { asProjectionRecord, textValue, type ProjectionRecord } from './subagentProjection'

function resultText(record: ProjectionRecord): string {
  const result = asProjectionRecord(record.result)
  for (const value of [record.output, record.resultPreview, result.output]) if (typeof value === 'string') return value
  const messages = Array.isArray(record.messages) ? record.messages.map(asProjectionRecord) : []
  const assistant = [...messages].reverse().find(message => message.role === 'assistant')
  if (typeof assistant?.text === 'string') return assistant.text
  if (typeof assistant?.content === 'string') return assistant.content
  if (Array.isArray(assistant?.content)) return assistant.content.map(asProjectionRecord).map(block => textValue(block.text)).filter(Boolean).join('\n')
  return ''
}

export default function LiveSubagentRecordPanel({ record, onClose }: { record: ProjectionRecord; onClose: () => void }) {
  const output = resultText(record)
  const usage = asProjectionRecord(record.usage)
  const error = textValue(record.error)
  const processExited = !textValue(record.activeRunId) && /Pi RPC process exited \(code=/.test(error)
  const modelMissing = /Model "[^"]+" not found/.test(error)
  return <aside aria-label="子助手历史记录" className="fixed inset-y-0 right-0 z-40 flex w-[min(560px,92vw)] flex-col border-l border-border bg-bg shadow-xl">
    <div className="flex items-start justify-between gap-3 border-b border-border p-3">
      <div className="min-w-0"><div className="break-words text-sm font-semibold">{textValue(record.label) || '子助手记录'}</div>
        <div className="text-2xs text-muted">{processExited ? '子助手进程已退出；以下为保存的任务记录，不再执行。' : '当前无实时连接；以下内容来自任务快照，不代表执行进程已退出'}</div>
      </div><button type="button" onClick={onClose} className="shrink-0 rounded px-2 py-1 hover:bg-bg-hover" aria-label="关闭子助手历史记录">关闭</button>
    </div>
    <div className="space-y-3 overflow-auto p-3 text-sm">
      {typeof record.model === 'string' && <div className="break-all text-2xs text-muted">模型：{record.model}{typeof record.thinkingLevel === 'string' && ` · 思考等级：${record.thinkingLevel}`}</div>}
      {typeof usage.input === 'number' && <div className="text-2xs text-muted">输入：{usage.input.toLocaleString()}{typeof usage.output === 'number' && ` · 输出：${usage.output.toLocaleString()}`}</div>}
      {error && <div role="alert" className="space-y-2 break-words rounded border border-danger p-2 text-danger">
        {modelMissing && <p>启动失败：所选模型不可用。请在子助手配置或任务参数中选择当前已注册的模型，再重新执行；主会话的模型不会自动替换它。</p>}
        <div>{error}</div>
      </div>}
      {output ? <MarkdownRenderer content={output} /> : <p className="text-muted">{modelMissing && processExited ? '子助手在模型启动阶段退出，本次没有生成结果。' : '此快照未提供结果正文。完整结果仍需从子助手工作台或保存的产物查看；这里不会编造内容。'}</p>}
      {record.resultTruncated === true && <p className="text-2xs text-warn">这里只展示结果摘要，完整结果未删除。</p>}
    </div>
  </aside>
}
