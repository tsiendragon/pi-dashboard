import { useState } from 'react'
import type { TaskFact } from '../../../shared/src/tasks'
import { Link } from 'react-router-dom'
import { supervisorApi, errorText } from '../features/supervisor/api'
import { useSupervisorResource } from '../features/supervisor/useSupervisorResource'
import { SupervisorAgentButton } from '../features/supervisor/SupervisorAgentProvider'
import { ConfigSummary, ObjectLink, Reports, Section, WorkingStateView, SessionLink, SupervisorFailure, buttonClass, timeText } from '../features/supervisor/SupervisorViews'

const observationLabels = { running: '运行中', idle: '空闲', stale: '已过期', offline: '离线', waiting_input: '等待输入', error: '错误', unknown: '未知' }
export default function SupervisorPage() {
  const state = useSupervisorResource(supervisorApi.state)
  const config = useSupervisorResource(supervisorApi.config, true, 0)
  const useAllScope = !!config.data && !config.data.allowedObjects.length && !config.data.allowedSessionIds.length
  const [configError, setConfigError] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [showOtherTasks, setShowOtherTasks] = useState(false)
  async function enableObservation() {
    if (!config.data || enabling) return
    setEnabling(true); setConfigError(null)
    try {
      await supervisorApi.configure({ ...config.data, enabled: true, allowedObjects: useAllScope ? ['*'] : config.data.allowedObjects, allowedSessionIds: useAllScope ? ['*'] : config.data.allowedSessionIds, agentResources: { ...config.data.agentResources, mode: 'observe' } })
      state.refresh(); config.refresh()
    } catch (error) { setConfigError(errorText(error)) } finally { setEnabling(false) }
  }
  const data = state.data
  const staleSample = data && config.data && Date.now() - new Date(data.sampledAt).getTime() > config.data.staleAfterMs
  const retry = () => { state.refresh(); config.refresh() }
  const currentSessions = new Set(data?.sessions
    .filter(session => session.observation !== 'offline' && session.processInstanceId !== data.agent.processInstanceId)
    .map(session => session.processInstanceId))
  const localProviders = new Set(data?.tasks.providers.filter(provider => provider.type === 'local').map(provider => provider.id))
  const focusIds = new Set(data?.tasks.tasks.filter(task => {
    if (task.archived) return false
    if (localProviders.has(task.providerId) || task.providerId === 'local') return true
    return task.completion !== 'done' && data.tasks.sessionRefs[task.uid]?.some(session =>
      session.live && currentSessions.has(session.processInstanceId))
  }).map(task => task.uid))
  const tasksById = new Map(data?.tasks.tasks.map(task => [task.uid, task]))
  for (const uid of focusIds) {
    const parentUid = tasksById.get(uid)?.parentUid
    if (parentUid && tasksById.has(parentUid)) focusIds.add(parentUid)
  }
  const focusTasks = data?.tasks.tasks.filter(task => focusIds.has(task.uid)) || []
  const otherTasks = data?.tasks.tasks.filter(task => !focusIds.has(task.uid)) || []
  const renderTasks = (tasks: TaskFact[]) => <ul className="space-y-3">{tasks.map(task => <li key={task.uid} className="border-b border-border pb-3 space-y-1">
    <ObjectLink uid={task.uid} title={task.title} />
    <p className="text-body-s text-muted">{task.tags.includes('project') ? '项目' : task.kind} · 来源事实：{task.completionRaw || task.completion} · 来源：{task.sourceLabel}（{task.providerId}）</p>
    <WorkingStateView state={data?.workingStates?.[task.uid]} />
    <div className="flex flex-wrap gap-3 text-body-s"><Link className="text-accent" to={'/tasks/events?objectRef=' + encodeURIComponent(task.uid)}>事件流水账</Link><SupervisorAgentButton objectRef={task.uid} className="text-accent hover:underline" /></div>
    {data?.tasks.sessionRefs[task.uid]?.map(session => <Link key={session.processInstanceId || session.sessionId} className="mr-3 text-accent text-body-s" to={'/live-sessions/' + encodeURIComponent(session.processInstanceId)}>{session.title || session.sessionId}{!session.live && '（非在线）'}</Link>)}
  </li>)}</ul>
  return <main className="mx-auto max-w-6xl p-4 sm:p-6 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">工作监督台</h1><p className="text-muted text-body-s">基于授权任务与会话证据；未知不当作正常。</p></div>
      <div className="flex gap-2"><button className={buttonClass} onClick={retry}>刷新</button><SupervisorAgentButton /></div>
    </header>
    <SupervisorFailure error={state.error || config.error} retry={retry} />
    {!!state.error && data && <p role="status" className="text-danger">刷新失败，以下为上次采样，不是当前事实。</p>}
    {state.loading && !data && <p role="status">正在读取监督状态…</p>}
    {(!data?.enabled || !config.data?.enabled) && <Section title="尚未启用"><p className="text-muted">监督服务已禁用或配置缺失。先核对下方资源路径，再显式启用；不会自动启动主 Agent 或协调其他会话。</p>{config.data && <button className={buttonClass} disabled={enabling} onClick={() => { void enableObservation() }}>{enabling ? '正在保存配置…' : useAllScope ? '启用观察并授权全部已接入任务和会话（不自动启动）' : '启用只读观察模式（不自动启动）'}</button>}{configError && <p role="alert" className="text-danger">{configError}</p>}</Section>}
    {data && <>
      <Section title="授权范围与采样">
        <p className="text-body-s">{data.mode === 'coordinate' ? '协调模式' : '观察模式'} · 采样：{timeText(data.sampledAt)} · 主会话资源：{data.agent.resourceState} · {data.agent.connected ? '已连接' : '未连接'}</p>
        {staleSample && <p className="text-danger">采样已超过配置的过期阈值，当前状态不能视为最新。</p>}
        {data.agent.error && <p role="alert" className="text-danger">{data.agent.error}</p>}
        {data.agent.extensionsStale && <p role="status" className="text-muted">扩展代码已更新（主会话仍在用启动时的版本）：现在可继续使用，建议结束后重新启动主会话以加载新代码。</p>}
        {data.agent.processInstanceId && <Link className="text-accent" to={'/live-sessions/' + encodeURIComponent(data.agent.processInstanceId)}>主管主会话 {data.agent.sessionId || data.agent.processInstanceId}</Link>}
        {[...data.warnings, ...data.tasks.warnings].map((warning, index) => <p key={index} role="status" className="text-danger">{warning}</p>)}
        {data.tasks.providers.filter(provider => !provider.available).map(provider => <p key={provider.id} className="text-danger">来源不可用：{provider.label}（{provider.id}），不能据此判断任务正常。</p>)}
      </Section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="项目 / Epic / Task">
          {!data.tasks.tasks.length && <p className="text-muted">当前授权范围内没有返回任务。</p>}
          <p className="text-body-s text-muted mb-3">优先显示在线会话关联的未完成任务和未归档本地任务，保留其项目 / Epic。其他任务仅在页面隐藏，不改变主 Agent 的访问权限。</p>
          {!!data.tasks.tasks.length && !focusTasks.length && <p className="text-muted">没有当前会话关联任务或未归档本地任务；其他任务可展开查看。</p>}
          {renderTasks(focusTasks)}
          {!!otherTasks.length && <div className="mt-3 space-y-3">
            <button type="button" className={buttonClass} aria-expanded={showOtherTasks} aria-controls="supervisor-other-tasks" onClick={() => setShowOtherTasks(value => !value)}>{showOtherTasks ? '收起' : '显示'}其他任务（{otherTasks.length}）</button>
            {showOtherTasks && <div id="supervisor-other-tasks">{renderTasks(otherTasks)}</div>}
          </div>}
        </Section>
        <Section title="会话观察">
          {!data.sessions.length && <p className="text-muted">当前授权范围内没有返回会话。</p>}
          <ul className="space-y-3">{data.sessions.map(session => <li key={session.processInstanceId} className="border-b border-border pb-3 space-y-1">
            <SessionLink session={session} />
            <p className={['stale', 'unknown', 'error', 'offline'].includes(session.observation) ? 'text-danger text-body-s' : 'text-muted text-body-s'}>{observationLabels[session.observation]} · {session.evidence || '无观察证据'}</p>
            <p className="text-muted text-2xs break-all">{session.cwd} · 活动：{timeText(Number.isFinite(session.lastActivityAt) ? new Date(session.lastActivityAt).toISOString() : null)}</p>
            {session.digest ? <>
              <p className="text-body-s"><span className="font-medium">最近输出摘要</span><span className="text-muted text-2xs">（摘自最近 {session.digest.coveredMessages} 条回复，新→旧，便于阅读；不是任务事实）</span></p>
              {session.digest.headline && <p className="text-body-s text-text-strong">{session.digest.headline}</p>}
              {!!session.digest.points.length && <ul className="list-disc space-y-0.5 pl-5 text-body-s text-muted">{session.digest.points.map((point, index) => <li key={index}>{point}</li>)}</ul>}
              {session.digest.waitingFor && <p className="text-body-s">在等：{session.digest.waitingFor}</p>}
              {session.digest.nextStep && <p className="text-body-s">下一步：{session.digest.nextStep}</p>}
              {session.lastText && <details className="text-body-s text-muted"><summary className="cursor-pointer">原始输出（末尾 {session.lastText.length} 字）</summary><p className="mt-1 whitespace-pre-wrap break-words">{session.lastText}</p></details>}
            </> : session.lastText && <p className="text-body-s whitespace-pre-wrap break-words">{session.lastText}</p>}
          </li>)}</ul>
        </Section>
      </div>
      <Section title="人工待办与建议">
        {!data.actions.length && <p className="text-muted">没有返回待办；不代表所有工作已完成。</p>}
        <ul className="space-y-3">{data.actions.map(action => <li key={action.id} className="border-b border-border pb-3 space-y-1">
          <h3 className="font-medium">{action.title} · {action.state}</h3>
          {action.objectRef && <ObjectLink uid={action.objectRef} />}
          <p className="text-body-s whitespace-pre-wrap">{action.reason}</p>
          <p className="text-muted text-2xs break-all">来源：{action.sourceRefs.join('、') || '未提供'} · 更新：{timeText(action.updatedAt)}</p>
          <SupervisorAgentButton objectRef={action.objectRef} prompt={'请检查人工待办 ' + action.id + '：' + action.title + '，根据来源说明下一步；任何修改先确认。'} className="text-accent text-body-s hover:underline">交给主管检查</SupervisorAgentButton>
        </li>)}</ul>
      </Section>
      <Section title="已保存报告"><Reports reports={data.reports} versions={Object.fromEntries(data.events.map(event => [event.id, event.version]))} /></Section>
    </>}
    <Section title="启动与配置（只读）"><ConfigSummary config={config.data} /><SupervisorAgentButton>打开主管启动面板</SupervisorAgentButton></Section>
  </main>
}
