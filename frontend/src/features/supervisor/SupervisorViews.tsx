import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { SupervisorConfig, SupervisorReport, SupervisorSession, SupervisorWorkingState } from '../../../../shared/src/supervisor'
import MarkdownRenderer from '../../components/MarkdownRenderer'
import { AuthPanel } from '../live-sessions/LiveSessionPage'
import { authenticated } from '../../store/liveSessionsSlice'
import { useAppDispatch } from '../../store'
import { errorText, SupervisorApiError } from './api'

export function WorkingStateView({ state }: { state?: SupervisorWorkingState }) {
  if (!state) return null
  return <div className="rounded-lg bg-bg-elevated p-2 text-body-s space-y-1">
    <p>本地观察（不改来源状态）：{state.stage || '阶段未记录'}</p>
    <p>下一步：{state.nextStep || '未记录'} · 等待：{state.waitingFor || '未记录'}</p>
    <p className="text-muted text-2xs">{state.sourceKind === 'relay' ? '用户转述，尚未独立核实' : '用户确认'} · {timeText(state.updatedAt)} · 事件 {state.sourceEventId}</p>
  </div>
}

export const panelClass = 'rounded-xl border border-border bg-card p-4 space-y-3'
export const buttonClass = 'rounded-lg border border-border px-3 py-2 text-body-s hover:bg-bg-elevated disabled:opacity-50 disabled:cursor-not-allowed'
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className={panelClass}><h2 className="font-semibold">{title}</h2>{children}</section>
}
export function SupervisorFailure({ error, retry }: { error: unknown; retry: () => void }) {
  const dispatch = useAppDispatch()
  if (!error) return null
  return <section className="rounded-lg border border-danger bg-danger-subtle p-3 space-y-3">
    <p role="alert" className="text-danger break-words">{errorText(error)}</p>
    {error instanceof SupervisorApiError && error.status === 401
      ? <AuthPanel onAuthenticated={browserClientId => { dispatch(authenticated({ browserClientId })); retry() }} />
      : <button className={buttonClass} onClick={retry}>重试</button>}
  </section>
}
export function missingResources(config: SupervisorConfig | null | undefined): string[] {
  if (!config) return ['配置']
  const missing: string[] = []
  if (!config.cwd?.trim()) missing.push('工作目录')
  if (!config.agentResources?.rolePath?.trim()) missing.push('角色文件')
  if (!config.agentResources?.skillPaths?.length) missing.push('Skill 文件')
  if (!config.agentResources?.extensionPaths?.length) missing.push('Extension 文件')
  return missing
}
export function ConfigSummary({ config }: { config: SupervisorConfig | null | undefined }) {
  if (!config) return <p className="text-muted">配置缺失，主管不可启用。由管理员配置；此页面不会自动开启。</p>
  const missing = missingResources(config)
  return <div className="space-y-2 text-body-s break-words">
    <p>{config.enabled ? '配置已启用' : '配置已禁用'} · {config.agentResources?.mode === 'coordinate' ? '协调模式' : '观察模式'}</p>
    {!!missing.length && <p className="text-danger">缺少资源：{missing.join('、')}</p>}
    <dl className="space-y-2">
      <div><dt className="text-muted">工作目录</dt><dd>{config.cwd || '未配置'}</dd></div>
      <div><dt className="text-muted">角色文件</dt><dd>{config.agentResources?.rolePath || '未配置'}</dd></div>
      <div><dt className="text-muted">Skill 文件</dt><dd>{config.agentResources?.skillPaths?.join('、') || '未配置'}</dd></div>
      <div><dt className="text-muted">Extension 文件</dt><dd>{config.agentResources?.extensionPaths?.join('、') || '未配置'}</dd></div>
      <div><dt className="text-muted">允许工具</dt><dd>{config.agentResources?.allowedTools?.join('、') || '无'}</dd></div>
      <div><dt className="text-muted">对象 UID 范围</dt><dd>{config.allowedObjects.join('、') || '未授权（空列表）'}</dd></div>
      <div><dt className="text-muted">允许会话</dt><dd>{config.allowedSessionIds.join('、') || '未授权（空列表）'}</dd></div>
      <div><dt className="text-muted">允许根目录</dt><dd>{config.allowedRoots.join('、') || '未配置'}</dd></div>
      <div><dt className="text-muted">事件类型词表</dt><dd>{config.eventTypes?.length ? config.eventTypes.join('、') : '未配置'}</dd></div>
    </dl>
    <p className="text-muted">状态过期阈值：{config.staleAfterMs / 1000} 秒。此处仅解释配置；启用或修改需要管理员权限，不会自动写入。</p>
  </div>
}
export function SessionLink({ session }: { session: Pick<SupervisorSession, 'processInstanceId' | 'sessionId' | 'sessionName'> }) {
  return <Link className="text-accent hover:underline break-all" to={'/live-sessions/' + encodeURIComponent(session.processInstanceId)}>{session.sessionName || session.sessionId}</Link>
}
export function ObjectLink({ uid, title }: { uid: string; title?: string }) {
  return <Link className="text-accent hover:underline break-all" to={'/tasks/' + encodeURIComponent(uid)}>{title || uid}{title && <span className="ml-2 text-muted text-2xs">{uid}</span>}</Link>
}
export function timeText(value: string | null | undefined) {
  if (!value) return '未知'
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString()
}
export function Reports({ reports, versions }: { reports: SupervisorReport[]; versions?: Record<string, number> }) {
  if (!reports.length) return <p className="text-muted">尚无已保存报告；可在主管弹窗中请求生成。</p>
  return <div className="space-y-4">{reports.map(report => {
    const outdated = versions && Object.entries(report.inputVersions).some(([id, version]) => versions[id] !== undefined && versions[id] !== version)
    const unverified = !versions || Object.keys(report.inputVersions).some(id => versions[id] === undefined)
    return <article key={report.id} className="border-t border-border pt-3 space-y-2">
      <h3 className="font-medium">{report.kind} · {timeText(report.createdAt)}</h3>
      {report.objectRef && <ObjectLink uid={report.objectRef} />}
      {outdated && <p className="text-danger">输入事件已更正，该报告已过期。</p>}
      {unverified && <p className="text-muted">部分输入事件版本未加载，报告时效尚不能确认。</p>}
      <MarkdownRenderer content={report.content} />
      <p className="text-muted text-body-s">覆盖：{report.coverage || '未知'}</p>
      {!!report.missing.length && <p className="text-danger">缺口：{report.missing.join('、')}</p>}
      <p className="text-muted text-2xs break-all">来源：{report.sourceRefs.join('、') || '未提供'} · 报告 {report.id}</p>
    </article>
  })}</div>
}
