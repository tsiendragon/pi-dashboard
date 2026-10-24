import { ACTIONS, ACTION_LABEL, AUTO_ESCALATION_TIERS, DAY_MS, HOUR_MS, ROLES, ROLE_LABEL, THINKING_LEVELS, TIERS, TIER_LABEL, msToUnit, patchCandidate, patchTier, unitToMs, type SubagentModelsConfig, type Tier } from './config'

const field = 'rounded-md border border-border bg-bg-elevated px-2 py-1 text-body-s text-text outline-none focus-ring'

function TierSelect({ value, onChange, label, options = TIERS }: { value: Tier | undefined; onChange: (t: Tier | undefined) => void; label: string; options?: readonly Tier[] }) {
  return (
    <select aria-label={label} className={field} value={value ?? ''} onChange={e => onChange((e.target.value || undefined) as Tier | undefined)}>
      <option value="">（不指定）</option>
      {options.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
    </select>
  )
}

export default function AdvancedSettings({ config, onChange }: { config: SubagentModelsConfig; onChange: (next: SubagentModelsConfig) => void }) {
  const numOrUndef = (v: string): number | undefined => (v.trim() === '' || Number(v) < 1 ? undefined : Math.floor(Number(v)))
  return (
    <details className="mt-3 border-t border-border pt-3">
      <summary className="cursor-pointer text-meta text-muted hover:text-text">高级设置</summary>
      <div className="mt-3 space-y-5">
        <section>
          <h4 className="mb-2 text-body-s font-semibold text-text-strong">默认档位</h4>
          <div className="flex flex-wrap items-center gap-3 text-body-s text-text">
            <label className="flex items-center gap-2">没指定时用
              <select aria-label="默认档位" className={field} value={config.defaultTier} onChange={e => onChange({ ...config, defaultTier: e.target.value as Tier })}>
                {TIERS.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </label>
            {ROLES.map(role => (
              <label key={role} className="flex items-center gap-2">{ROLE_LABEL[role]}
                <select aria-label={`角色档位 ${role}`} className={field} value={config.roles[role] ?? config.defaultTier} onChange={e => onChange({ ...config, roles: { ...config.roles, [role]: e.target.value as Tier } })}>
                  {TIERS.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
                </select>
              </label>
            ))}
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={config.allowInherit} onChange={e => onChange({ ...config, allowInherit: e.target.checked })} />
              允许继承主会话模型
            </label>
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-body-s font-semibold text-text-strong">候选模型的细项</h4>
          {TIERS.every(t => config.tiers[t].candidates.length === 0) && <p className="text-meta text-muted">还没有分配任何模型。</p>}
          {TIERS.map(tier => config.tiers[tier].candidates.map((c, i) => (
            <div key={`${tier}/${c.model}`} className="mb-1.5 rounded-md border border-border px-3 py-2 text-body-s">
              <div className="flex items-baseline gap-2">
                <span className="w-10 shrink-0 text-meta text-muted">{TIER_LABEL[tier]}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-text">{c.model}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-12">
              <select aria-label={`思考强度 ${c.model}`} className={field} value={c.thinking ?? ''} onChange={e => onChange(patchCandidate(config, tier, i, { thinking: e.target.value || undefined }))}>
                <option value="">思考：默认</option>
                {THINKING_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <input aria-label={`最大并发 ${c.model}`} type="number" min={1} placeholder="最大并发" className={`${field} w-24`} value={c.maxConcurrency ?? ''} onChange={e => onChange(patchCandidate(config, tier, i, { maxConcurrency: numOrUndef(e.target.value) }))} />
              <input aria-label={`额度组 ${c.model}`} placeholder="额度组" className={`${field} w-28`} value={c.quotaGroup ?? ''} onChange={e => onChange(patchCandidate(config, tier, i, { quotaGroup: e.target.value }))} />
              </div>
            </div>
          )))}
        </section>

        <section>
          <h4 className="mb-2 text-body-s font-semibold text-text-strong">一档里的模型都用不了时怎么办</h4>
          <div className="space-y-1">
            {TIERS.map(tier => {
              const ex = config.tiers[tier].onExhausted
              const set = (patch: Record<string, unknown>) => {
                const next = { ...(ex ?? { action: 'fail' }), ...patch }
                for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k]
                onChange(patchTier(config, tier, { onExhausted: next as never }))
              }
              return (
                <div key={tier} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border px-2 py-1.5 text-body-s">
                  <span className="w-12 shrink-0 text-muted">{TIER_LABEL[tier]}</span>
                  <select aria-label={`用完动作 ${tier}`} className={field} value={ex?.action ?? ''} onChange={e => e.target.value ? set({ action: e.target.value }) : onChange(patchTier(config, tier, { onExhausted: undefined }))}>
                    <option value="">（默认）</option>
                    {ACTIONS.map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                  </select>
                  {ex && (ex.action === 'wait' || ex.action === 'wait_then_escalate') && (
                    <label className="flex items-center gap-1 text-muted">最多等
                      <input aria-label={`最长等待秒数 ${tier}`} type="number" min={1} className={`${field} w-20`} value={msToUnit(ex.maxWaitMs, 1000)} onChange={e => set({ maxWaitMs: unitToMs(e.target.value, 1000) })} />秒
                    </label>
                  )}
                  {ex && (ex.action === 'wait_then_escalate' || ex.action === 'escalate') && (
                    <label className="flex items-center gap-1 text-muted">升级到
                      <TierSelect label={`升级到 ${tier}`} value={ex.escalateTo} options={AUTO_ESCALATION_TIERS.filter(t => t !== tier)} onChange={t => set({ escalateTo: t })} />
                    </label>
                  )}
                  <label className="flex items-center gap-1 text-muted">
                    <input type="checkbox" className="h-4 w-4 accent-accent" checked={config.tiers[tier].spillover ?? false} onChange={e => onChange(patchTier(config, tier, { spillover: e.target.checked }))} />
                    候选满了顺延到下一个
                  </label>
                </div>
              )
            })}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-body-s font-semibold text-text-strong">时限与预算</h4>
          <div className="flex flex-wrap items-center gap-4 text-body-s text-muted">
            <label className="flex items-center gap-1">单任务持续工作上限
              <input aria-label="持续工作小时数" type="number" min={0} className={`${field} w-20`} value={msToUnit(config.timeouts?.workHardMs, HOUR_MS)} onChange={e => onChange({ ...config, timeouts: { ...config.timeouts, workHardMs: unitToMs(e.target.value, HOUR_MS) } })} />小时
            </label>
            <label className="flex items-center gap-1">绝对上限
              <input aria-label="绝对上限天数" type="number" min={0} className={`${field} w-20`} value={msToUnit(config.timeouts?.workHardMaxMs, DAY_MS)} onChange={e => onChange({ ...config, timeouts: { ...config.timeouts, workHardMaxMs: unitToMs(e.target.value, DAY_MS) } })} />天
            </label>
            <label className="flex items-center gap-1">单任务最多调用模型
              <input aria-label="模型调用次数上限" type="number" min={1} className={`${field} w-24`} value={config.budgets?.maxModelCallsPerTask ?? ''} onChange={e => onChange({ ...config, budgets: { ...config.budgets, maxModelCallsPerTask: numOrUndef(e.target.value) } })} />次
            </label>
          </div>
        </section>
      </div>
    </details>
  )
}
