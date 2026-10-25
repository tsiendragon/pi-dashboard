import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SupervisorAnalysis, SupervisorEvent } from '../../../shared/src/supervisor'
import { supervisorApi } from '../features/supervisor/api'
import { SupervisorAgentButton } from '../features/supervisor/SupervisorAgentProvider'
import { PendingConfirmations } from '../features/supervisor/PendingConfirmations'
import { useSupervisorResource } from '../features/supervisor/useSupervisorResource'
import { EventTimeline } from '../features/supervisor/EventTimeline'
import { ObjectLink, Reports, Section, WorkingStateView, SupervisorFailure, buttonClass, timeText } from '../features/supervisor/SupervisorViews'
import { TasksSectionTabs } from './tasks/TasksSectionTabs'
function eventList(result: SupervisorEvent[]): SupervisorEvent[] {
  if (!Array.isArray(result)) throw new Error('事件响应不符合契约；没有确认任何事件记录。')
  return result
}
function TimeAnalysis({ analysis }: { analysis: SupervisorAnalysis }) {
  return <div className="space-y-3">
    <p className="text-body-s">实际投入：{analysis.actualEffortMinutes === null ? '未知（没有可靠投入记录）' : analysis.actualEffortMinutes + ' 分钟'} · 统计：{timeText(analysis.computedAt)}</p>
    {!!analysis.missing.length && <p className="text-danger">缺口：{analysis.missing.join('、')}</p>}
    {!analysis.intervals.length && <p className="text-muted">没有可计算区间；不是零耗时。</p>}
    <ul className="space-y-3">{analysis.intervals.map((interval, index) => <li key={index} className="border-b border-border pb-3 space-y-1">
      <ObjectLink uid={interval.objectRef} />
      <p>{interval.kind}{interval.stage && ' · ' + interval.stage}：{interval.minutes === null ? '未知' : interval.minutes + ' 分钟'}</p>
      <p className="text-muted text-2xs break-all">来源事件：{interval.startEventId} → {interval.endEventId}</p>
      {interval.warning && <p className="text-danger">{interval.warning}</p>}
    </li>)}</ul>
    <p className="text-muted text-body-s">历时、等待和实际投入不同；未知不算零，重叠区间不在前端重复求和。</p>
  </div>
}
export default function EventLedgerPage() {
  const [params, setParams] = useSearchParams()
  const objectRef = params.get('objectRef') || ''
  const includeChildren = params.get('includeChildren') === 'true'
  const [tab, setTab] = useState<'events' | 'analysis' | 'reports'>('events')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [withImages, setWithImages] = useState(false)
  const [order, setOrder] = useState<'desc' | 'asc'>('desc')
  const state = useSupervisorResource(supervisorApi.state)
  const loadEvents = useCallback(async (signal: AbortSignal) => ({
    objectRef, includeChildren,
    events: eventList(await supervisorApi.execute<SupervisorEvent[]>({ operation: 'events', args: { objectRef, includeChildren } }, signal)),
  }), [objectRef, includeChildren])
  const events = useSupervisorResource(loadEvents, !!objectRef && !!state.data && tab === 'events')
  const loadAnalysis = useCallback(async (signal: AbortSignal) => {
    const analysis = await supervisorApi.execute<SupervisorAnalysis>({ operation: 'analyze', args: { objectRef, includeChildren } }, signal)
    if (!analysis || !Array.isArray(analysis.intervals)) throw new Error('分析响应不符合契约，耗时未知。')
    return { objectRef, includeChildren, analysis }
  }, [objectRef, includeChildren])
  const analysis = useSupervisorResource(loadAnalysis, !!objectRef && !!state.data && tab === 'analysis', 0)
  const tasks = state.data?.tasks.tasks || []
  const selected = tasks.find(task => task.uid === objectRef)
  const archivedRefs = [...new Set([...(state.data?.archivedObjectRefs || []), ...(state.data?.events || []).map(event => event.objectRef)])].filter(ref => !tasks.some(task => task.uid === ref))
  const currentEvents = events.data?.objectRef === objectRef && events.data.includeChildren === includeChildren ? events.data.events : undefined
  const currentAnalysis = analysis.data?.objectRef === objectRef && analysis.data.includeChildren === includeChildren ? analysis.data.analysis : undefined
  const scopedUids = new Set([objectRef])
  if (includeChildren) {
    let changed = true
    while (changed) {
      changed = false
      for (const task of tasks) if (task.parentUid && scopedUids.has(task.parentUid) && !scopedUids.has(task.uid)) { scopedUids.add(task.uid); changed = true }
    }
  }
  const reports = (state.data?.reports || []).filter(report => report.objectRef && scopedUids.has(report.objectRef))
  const versions = Object.fromEntries([...(state.data?.events || []), ...(currentEvents || [])].map(event => [event.id, event.version]))
  const eventTypes = useMemo(() => [...new Set((currentEvents || []).map(event => event.type))].sort(), [currentEvents])
  const visibleEvents = useMemo(() => (currentEvents || [])
    .filter(event => !typeFilter || event.type === typeFilter)
    .filter(event => !withImages || event.attachmentIds.length > 0), [currentEvents, typeFilter, withImages])
  const retry = () => { state.refresh(); events.refresh(); analysis.refresh() }
  const changeScope = (uid: string, children: boolean) => {
    const next = new URLSearchParams(params)
    if (uid) next.set('objectRef', uid); else next.delete('objectRef')
    if (children) next.set('includeChildren', 'true'); else next.delete('includeChildren')
    setParams(next)
  }
  return <main className="mx-auto max-w-5xl p-4 sm:p-6 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><div className="mb-2"><TasksSectionTabs active="events" /></div><h1 className="text-xl font-semibold">事件流水账</h1><p className="text-muted text-body-s">Tasks 的下一级视图：按稳定对象 UID 查询事实、来源、修订和分析。</p></div><div className="flex gap-2"><button className={buttonClass} onClick={retry}>刷新</button><SupervisorAgentButton objectRef={objectRef || undefined} /></div></header>
    {objectRef && <PendingConfirmations objectRef={objectRef} />}
    <SupervisorFailure error={state.error} retry={retry} />
    {!!state.error && state.data && <p className="text-danger">监督状态刷新失败，任务范围与报告来自上次采样。</p>}
    {state.loading && !state.data && <p role="status">正在读取任务范围…</p>}
    {state.data && !state.data.enabled && <p className="text-muted">主管未启用；只尝试读取已有事件，不会自动开启配置。</p>}
    {state.data?.warnings.map((warning, index) => <p key={index} className="text-danger">{warning}</p>)}
    {state.data?.tasks.warnings.map((warning, index) => <p key={index} className="text-danger">{warning}</p>)}
    <Section title="项目 / Epic / Task 选择">
      <label htmlFor="ledger-object" className="text-body-s">对象（以 UID 区分同名任务）</label>
      <select id="ledger-object" value={objectRef} onChange={event => changeScope(event.target.value, includeChildren)} className="block w-full rounded-lg border border-border bg-bg p-2">
        <option value="">请选择任务或 Epic</option>
        {objectRef && !selected && !archivedRefs.includes(objectRef) && <option value={objectRef}>未知或不在已加载范围内 · {objectRef}</option>}
        {tasks.filter(task => task.plannable || task.uid === objectRef).map(task => <option key={task.uid} value={task.uid}>{task.title} · {task.tags.includes('project') ? '项目' : task.kind} · {task.sourceLabel} · {task.uid}</option>)}
        {archivedRefs.map(ref => <option key={ref} value={ref}>历史档案 · 原任务来源不可用 · {(state.data?.events.find(event => event.objectRef === ref)?.objectSnapshot?.title || ref)}</option>)}
      </select>
      <label className="flex items-center gap-2 text-body-s"><input type="checkbox" checked={includeChildren} onChange={event => changeScope(objectRef, event.target.checked)} />包含子对象事件</label>
      <WorkingStateView state={state.data?.workingStates?.[objectRef]} />
      {objectRef && <ObjectLink uid={objectRef} title={selected?.title} />}
      {objectRef && !selected && state.data && <p className="text-danger">对象 UID 无法在当前任务来源中解析；保留原 UID 查询，服务端仍需授权，不能猜测标题。</p>}
    </Section>
    <div role="tablist" aria-label="流水账视图" className="flex gap-2">{(['events', 'analysis', 'reports'] as const).map(value => <button id={'ledger-tab-' + value} key={value} role="tab" aria-controls={'ledger-panel-' + value} aria-selected={tab === value} onClick={() => setTab(value)} className={buttonClass + (tab === value ? ' bg-bg-elevated text-accent' : '')}>{value === 'events' ? '时间线' : value === 'analysis' ? '时间分析' : '报告'}</button>)}</div>
    {!objectRef && <p className="text-muted">选择对象后读取真实记录；无选择时不推测统计。</p>}
    {objectRef && <section role="tabpanel" id={'ledger-panel-' + tab} aria-labelledby={'ledger-tab-' + tab} className="space-y-4">
      {tab === 'events' && <>
        <SupervisorFailure error={events.error} retry={events.refresh} />
        {!!currentEvents?.length && <div className="flex flex-wrap items-center gap-2 text-2xs">
          <span className="text-muted">类型</span>
          <button type="button" onClick={() => setTypeFilter('')} aria-pressed={!typeFilter} className={buttonClass + (!typeFilter ? ' bg-bg-elevated text-accent' : '')}>全部</button>
          {eventTypes.map(type => <button key={type} type="button" onClick={() => setTypeFilter(current => current === type ? '' : type)} aria-pressed={typeFilter === type} className={buttonClass + (typeFilter === type ? ' bg-bg-elevated text-accent' : '')}>{type}</button>)}
          <span className="ml-2 text-muted">视图</span>
          <button type="button" onClick={() => setWithImages(current => !current)} aria-pressed={withImages} className={buttonClass + (withImages ? ' bg-bg-elevated text-accent' : '')}>只看有图片</button>
          <button type="button" onClick={() => setOrder(current => current === 'desc' ? 'asc' : 'desc')} className={buttonClass}>{order === 'desc' ? '新 → 旧' : '旧 → 新'}</button>
        </div>}
        {!!events.error && currentEvents && <p className="text-danger">事件刷新失败，以下保留上次成功记录。</p>}
        {events.loading && !currentEvents && <p role="status">正在查询事件…</p>}
        {currentEvents?.length === 0 && <p className="text-muted">该对象没有返回事件；不代表没有发生工作。</p>}
        <EventTimeline
          key={objectRef + (includeChildren ? ':children' : '')}
          events={visibleEvents}
          tasks={tasks}
          sessions={state.data?.sessions || []}
          order={order}
        />
      </>}
      {tab === 'analysis' && <>
        <SupervisorFailure error={analysis.error} retry={analysis.refresh} />
        {analysis.loading && !currentAnalysis && <p role="status">正在计算时间分析…</p>}
        {!!analysis.error && currentAnalysis && <p className="text-danger">分析刷新失败，以下为上次计算结果。</p>}
        {currentAnalysis && <Section title="确定性时间分析"><TimeAnalysis analysis={currentAnalysis} /></Section>}
        <SupervisorAgentButton objectRef={objectRef} prompt="请结合该对象事件和来源，分析瓶颈与证据缺口。未知投入不要算作零；保存报告前说明覆盖范围。">请主管解释分析</SupervisorAgentButton>
      </>}
      {tab === 'reports' && <Section title="该对象已保存报告"><Reports reports={reports} versions={versions} /><SupervisorAgentButton objectRef={objectRef} prompt="请基于该对象当前事件版本生成复盘报告，明确来源、覆盖范围和缺口；涉及保存或修改请先确认。">请求复盘报告</SupervisorAgentButton></Section>}
    </section>}
  </main>
}
