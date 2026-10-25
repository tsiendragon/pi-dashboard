import type React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import LineIcon, { type LineIconName } from '../components/LineIcon'
import { useLocale, setLocale } from '../utils/i18n'
import MaterialIcon from '../components/MaterialIcon'
import InfoTip from '../components/InfoTip'
import { api, j } from '../api/client'
import { useAppSelector } from '../store'
import { useTheme, THEMES, type ThemeId } from '../hooks/useTheme'
import { useCustomStyle, parseVars } from '../hooks/useCustomStyle'
import { BUILTIN_THEMES } from '../themes'
import { loadChatConfig, saveChatConfig, type ChatConfig } from './chat/ChatSettings'
import { loadTtsSettings, saveTtsSettings, type TtsSettings } from '../features/voice/ttsSettings'
import { useVoiceOutput } from '../features/voice/useVoiceOutput'
import { asrLanguageLabel, ASR_REALTIME_MODEL, ASR_LANGUAGES, type AsrConfigResponse } from '@shared/asr.js'
import { TTS_LANGUAGES, TTS_MODELS, TTS_VOICES, type TtsConfigResponse } from '@shared/tts.js'
import { SettingsSectionSlot } from '../plugins/slot-consumers'
import { ACTIONS, formatKey, setShortcut, resetShortcut, resetAllShortcuts, hasCustomShortcuts, subscribeShortcuts, eventToKeyString, type ActionCategory } from '../shortcuts'
import SubagentModelsTab from '../features/subagent-models/SubagentModelsTab'
import { modelFullId, modelPatternMatches, splitModelFullId, splitThinkingSuffix } from '../utils/modelUtils'
import { modelSelectionPatterns, selectedModelIds } from '../utils/modelSelection'

/**
 * PUT helper for the settings dashboards.
 *
 * `fetch` does not throw on HTTP errors, so the old code reported "Saved" even when the server
 * rejected the write (e.g. 401 from the browser-auth gate on settings/extension writes). Surface the
 * server's reason — including the auth hint — instead of pretending success.
 */
async function putJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string; hint?: string; data?: unknown }> {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => ({}))) as { error?: string; hint?: string }
    if (response.ok) return { ok: true, data: payload }
    return { ok: false, error: payload.error ?? `HTTP ${response.status}`, hint: payload.hint }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

type Tab = 'general' | 'model' | 'models' | 'subagent-models' | 'behavior' | 'terminal' | 'skills' | 'chat' | 'voice' | 'display' | 'vault' | 'tasks' | 'lark' | 'developer' | 'shortcuts'

/* ── Shared form components ── */

/** 设置卡片：圆角、整卡一块；标题缩进与行一致，内部子块统一左右内边距。 */
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`mb-4 overflow-hidden rounded-xl border border-border bg-card px-4 pb-1 ${className}`}>
      {children}
    </div>
  )
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 flex items-center gap-2 pb-1 pt-3 text-title font-semibold text-text-strong">{children}</h3>
}

/** 行左侧：名称 + 说明；cfg 为对应的配置 key，以 code 标签附在说明后。 */
function RowLabel({ label, hint, cfg }: { label: string; hint?: string; cfg?: string }) {
  const { tr } = useLocale()
  return (
    <div className="min-w-0 flex-1">
      <div className="text-body-s font-medium text-text">{label}</div>
      {(hint || cfg) && (
        <div className="mt-0.5 text-meta text-muted">
          {hint}
          {hint && cfg ? ' · ' : ''}
          {cfg && <>{tr('对应配置', 'Config')} <code className="rounded-sm bg-bg-accent px-1 font-mono text-2xs">{cfg}</code></>}
        </div>
      )}
    </div>
  )
}

function Toggle({ label, hint, cfg, checked, onChange }: { label: string; hint?: string; cfg?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
      <RowLabel label={label} hint={hint} cfg={cfg} />
      <div className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-border'}`} onClick={() => onChange(!checked)}>
        <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </div>
    </label>
  )
}

/** 分段按钮：选项少（≤6）时替代下拉，行为与下拉一致（单选、onChange(value)）。 */
function Segmented({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="ml-4 inline-flex flex-wrap rounded-lg bg-bg-accent p-0.5">
      {options.map(o => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={`cursor-pointer rounded-md border-none px-2.5 py-1 text-meta transition-colors ${on ? 'bg-card font-medium text-accent shadow-sm' : 'bg-transparent text-muted hover:text-text'}`}
            onClick={() => { if (!on) onChange(o.value) }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function SelectRow({ label, hint, cfg, value, options, onChange, seg }: { label: string; hint?: string; cfg?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; seg?: boolean }) {
  const asSegments = seg && options.length <= 6
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <RowLabel label={label} hint={hint} cfg={cfg} />
      {asSegments ? (
        <Segmented label={label} value={value} options={options} onChange={onChange} />
      ) : (
        <select
          aria-label={label}
          className="focus-ring ml-4 min-w-40 max-w-64 cursor-pointer rounded-lg border border-border bg-bg-elevated px-3 py-1.5 font-body text-body-s text-text outline-none transition-colors"
          value={value}
          onChange={e => onChange(e.target.value)}
        >
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  )
}

function NumberRow({ label, hint, cfg, value, onChange, min, max, step, placeholder }: { label: string; hint?: string; cfg?: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; placeholder?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <RowLabel label={label} hint={hint} cfg={cfg} />
      <input
        type="number"
        aria-label={label}
        className="focus-ring ml-4 w-28 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-right font-mono text-body-s text-text outline-none transition-colors"
        value={value ?? ''}
        onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
      />
    </div>
  )
}

function TextRow({ label, hint, cfg, value, onChange, placeholder, mono }: { label: string; hint?: string; cfg?: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <RowLabel label={label} hint={hint} cfg={cfg} />
      <input
        aria-label={label}
        className={`focus-ring ml-4 w-64 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-right text-body-s text-text outline-none transition-colors ${mono ? 'font-mono' : 'font-body'}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

function SettingsLoading() {
  const { tr } = useLocale()
  return <div className="py-4 text-body-s text-muted">{tr('正在加载设置…', 'Loading settings…')}</div>
}

/* ── Pi settings type ── */

interface PiSettings {
  defaultProvider?: string
  defaultModel?: string
  enabledModels?: string[]
  packages?: (string | object)[]
  defaultThinkingLevel?: string
  hideThinkingBlock?: boolean
  enableSkillCommands?: boolean
  steeringMode?: string
  followUpMode?: string
  theme?: string
  shellPath?: string
  quietStartup?: boolean
  shellCommandPrefix?: string
  collapseChangelog?: boolean
  doubleEscapeAction?: string
  treeFilterMode?: string
  showHardwareCursor?: boolean
  editorPaddingX?: number
  autocompleteMaxVisible?: number
  compaction?: {
    enabled?: boolean
    reserveTokens?: number
    keepRecentTokens?: number
  }
  branchSummary?: {
    reserveTokens?: number
    skipPrompt?: boolean
  }
  retry?: {
    enabled?: boolean
    maxRetries?: number
    baseDelayMs?: number
    maxDelayMs?: number
  }
  terminal?: {
    showImages?: boolean
    clearOnShrink?: boolean
  }
  images?: {
    autoResize?: boolean
    blockImages?: boolean
  }
  thinkingBudgets?: {
    minimal?: number
    low?: number
    medium?: number
    high?: number
    xhigh?: number
  }
  markdown?: {
    codeBlockIndent?: string
  }
  extensions?: string[]
  skills?: string[]
  prompts?: string[]
  themes?: string[]
  [key: string]: unknown
}

/* ── Feedback banner ── */
function Feedback({ feedback }: { feedback: { type: 'ok' | 'err'; msg: string } | null }) {
  if (!feedback) return null
  return (
    <div className={`px-3 py-2 rounded-md text-body-s font-medium animate-scale-in ${feedback.type === 'ok' ? 'bg-ok-subtle text-ok border border-ok' : 'bg-danger-subtle text-danger border border-danger'}`}>
      {feedback.msg}
    </div>
  )
}

/* ── Shared settings hook ── */
function usePiSettings() {
  const { tr } = useLocale()
  const [settings, setSettings] = useState<PiSettings | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)
  useEffect(() => {
    fetch('/api/pi/settings').then(j).then(setSettings).catch(() => {})
  }, [])

  const save = useCallback(async (next: PiSettings) => {
    setSettings(next)
    const result = await putJson('/api/pi/settings', next)
    setFeedback(result.ok
      ? { type: 'ok', msg: tr('已保存', 'Saved') }
      : { type: 'err', msg: result.hint ? `${tr('未保存', 'Not saved')}：${result.error} —— ${result.hint}` : `${tr('未保存', 'Not saved')}：${result.error}` })
    setTimeout(() => setFeedback(null), result.ok ? 2000 : 8000)
  }, [tr])

  const set = useCallback((key: string, value: unknown) => {
    if (!settings) return
    save({ ...settings, [key]: value })
  }, [settings, save])

  const setNested = useCallback((parent: string, key: string, value: unknown) => {
    if (!settings) return
    const existing = (settings as any)[parent] || {}
    save({ ...settings, [parent]: { ...existing, [key]: value } })
  }, [settings, save])

  return { settings, feedback, set, setNested, save, setSettings }
}

/* ── MODEL TAB ── */
type ModelOption = { id: string; name?: string; provider: string }

function ModelTab() {
  const { tr } = useLocale()
  const { settings, feedback, set, setNested, save } = usePiSettings()
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])

  useEffect(() => {
    fetch('/api/models').then(j).then(r => setAvailableModels(r?.models || [])).catch(() => {})
  }, [])

  if (!settings) return <SettingsLoading />

  const currentDefaultModel = (() => {
    const raw = settings.defaultModel ? splitThinkingSuffix(settings.defaultModel).modelPattern : ''
    if (!raw) return ''
    return raw.includes('/') ? raw : settings.defaultProvider ? `${settings.defaultProvider}/${raw}` : raw
  })()
  const providers = Array.from(new Set([
    ...(settings.defaultProvider ? [settings.defaultProvider] : []),
    ...availableModels.map(m => m.provider),
  ])).filter(Boolean).sort()
  const providerModels = settings.defaultProvider
    ? availableModels.filter(m => m.provider === settings.defaultProvider)
    : availableModels

  const updateDefaultModel = (value: string) => {
    if (!value) {
      save({ ...settings, defaultModel: undefined })
      return
    }
    const split = splitModelFullId(value)
    if (split) {
      save({ ...settings, defaultProvider: split.provider, defaultModel: split.modelId })
    } else {
      save({ ...settings, defaultModel: value })
    }
  }

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />

      <Card>
        <CardTitle>{tr('默认模型', 'Default Model')} <InfoTip text={tr('新会话使用的服务商与模型', 'Provider and model used for new sessions')} /></CardTitle>
        <div className="divide-y divide-border">
          <SelectRow
            label={tr('默认服务商', 'Default Provider')}
            hint={tr('新会话使用的 LLM 服务商', 'LLM provider for new sessions')}
            cfg="defaultProvider"
            value={settings.defaultProvider || ''}
            options={[
              { value: '', label: tr('— 默认 —', '— default —') },
              ...providers.map(p => ({ value: p, label: p }))
            ]}
            onChange={v => set('defaultProvider', v || undefined)}
          />
          <SelectRow
            label={tr('默认模型', 'Default Model')}
            hint={tr('新会话使用的模型', 'Model used for new sessions')}
            cfg="defaultModel"
            value={currentDefaultModel}
            options={[
              { value: '', label: tr('— 默认 —', '— default —') },
              ...providerModels.map(m => ({ value: modelFullId(m), label: m.name ? `${m.name} (${m.id})` : m.id }))
            ]}
            onChange={updateDefaultModel}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('思考', 'Thinking')} <InfoTip text={tr('控制模型回答前推理的深度', 'Controls how deeply the model reasons before responding')} /></CardTitle>
        <div className="divide-y divide-border">
          <SelectRow
            seg
            label={tr('默认思考强度', 'Default thinking level')}
            hint={tr('新会话的推理深度', 'Depth of reasoning for new sessions')}
            cfg="defaultThinkingLevel"
            value={settings.defaultThinkingLevel || 'medium'}
            options={[
              { value: 'off', label: tr('关', 'Off') },
              { value: 'minimal', label: tr('极低', 'Minimal') },
              { value: 'low', label: tr('低', 'Low') },
              { value: 'medium', label: tr('中', 'Medium') },
              { value: 'high', label: tr('高', 'High') },
              { value: 'xhigh', label: tr('特高', 'Extra High') },
              { value: 'max', label: tr('最高', 'Max') },
            ]}
            onChange={v => set('defaultThinkingLevel', v)}
          />
          <Toggle label={tr('隐藏思考块', 'Hide thinking blocks')} hint={tr('在 TUI 中折叠思考内容', 'Collapse thinking output in the TUI')} cfg="hideThinkingBlock" checked={settings.hideThinkingBlock ?? false} onChange={v => set('hideThinkingBlock', v)} />
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('思考预算', 'Thinking Budgets')} <InfoTip text={tr('每个思考强度分配的 token 预算。越高推理越充分，但越慢。', 'Token budgets allocated per thinking level. Higher = more thorough reasoning but slower.')} /></CardTitle>
        <div className="divide-y divide-border">
          <NumberRow label={tr('极低', 'Minimal')} hint={tr("“minimal”思考的 token 数", "Tokens for 'minimal' thinking")} cfg="thinkingBudgets.minimal" value={settings.thinkingBudgets?.minimal} onChange={v => setNested('thinkingBudgets', 'minimal', v)} placeholder="1024" />
          <NumberRow label={tr('低', 'Low')} hint={tr("“low”思考的 token 数", "Tokens for 'low' thinking")} cfg="thinkingBudgets.low" value={settings.thinkingBudgets?.low} onChange={v => setNested('thinkingBudgets', 'low', v)} placeholder="2048" />
          <NumberRow label={tr('中', 'Medium')} hint={tr("“medium”思考的 token 数", "Tokens for 'medium' thinking")} cfg="thinkingBudgets.medium" value={settings.thinkingBudgets?.medium} onChange={v => setNested('thinkingBudgets', 'medium', v)} placeholder="4096" />
          <NumberRow label={tr('高', 'High')} hint={tr("“high”思考的 token 数", "Tokens for 'high' thinking")} cfg="thinkingBudgets.high" value={settings.thinkingBudgets?.high} onChange={v => setNested('thinkingBudgets', 'high', v)} placeholder="8192" />
          <NumberRow label={tr('特高', 'Extra High')} hint={tr("“xhigh”思考的 token 数", "Tokens for 'xhigh' thinking")} cfg="thinkingBudgets.xhigh" value={settings.thinkingBudgets?.xhigh} onChange={v => setNested('thinkingBudgets', 'xhigh', v)} placeholder="16384" />
        </div>
      </Card>

    </div>
  )
}

function ModelListTab() {
  const { settings, feedback, save } = usePiSettings()
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [defaultModels, setDefaultModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelQuery, setModelQuery] = useState('')
  const [selectionError, setSelectionError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/models/catalog').then(j).catch(() => ({ models: [] })),
      fetch('/api/models').then(j).catch(() => ({ models: [] })),
    ]).then(([catalog, defaults]) => {
      if (cancelled) return
      setAvailableModels(catalog?.models || [])
      setDefaultModels(defaults?.models || [])
      setModelsLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  if (!settings) return <SettingsLoading />

  const enabledPatterns = settings.enabledModels || []
  const selectedIds = selectedModelIds(availableModels, enabledPatterns, defaultModels)
  const modelGroups = Array.from(new Set(availableModels.map(model => model.provider))).sort().map(provider => ({
    provider,
    models: availableModels.filter(model => model.provider === provider),
  })).filter(group => {
    const query = modelQuery.trim().toLowerCase()
    return !query || group.provider.toLowerCase().includes(query) || group.models.some(model => `${model.name || ''} ${model.id}`.toLowerCase().includes(query))
  })
  const unmatchedPatterns = enabledPatterns.filter(pattern => !availableModels.some(model => modelPatternMatches(pattern, model)))

  const saveModelSelection = (nextIds: Set<string>) => {
    setSelectionError('')
    if (nextIds.size === 0) {
      setSelectionError('至少保留一个模型；如需恢复默认列表，请使用“恢复默认”。')
      return
    }
    save({ ...settings, enabledModels: modelSelectionPatterns(availableModels, nextIds, enabledPatterns) })
  }

  const restoreDefaults = async () => {
    setSelectionError('')
    await save({ ...settings, enabledModels: undefined })
    const result = await fetch('/api/models').then(j).catch(() => ({ models: [] }))
    setDefaultModels(result?.models || [])
  }

  const selectProvider = (provider: string, enabled: boolean) => {
    const next = new Set(selectedIds)
    for (const model of availableModels.filter(model => model.provider === provider)) {
      const id = modelFullId(model)
      if (enabled) next.add(id)
      else next.delete(id)
    }
    saveModelSelection(next)
  }

  const selectModel = (model: ModelOption, enabled: boolean) => {
    const next = new Set(selectedIds)
    const id = modelFullId(model)
    if (enabled) next.add(id)
    else next.delete(id)
    saveModelSelection(next)
  }

  const selectAll = () => saveModelSelection(new Set(availableModels.map(modelFullId)))

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />
      <Card>
        <CardTitle>Providers & Models <InfoTip text="Choose which Pi-provided models appear in the model picker. Provider credentials are configured in Pi, not here." /></CardTitle>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 max-w-xl text-meta text-muted">点击 Provider 可全选或取消该服务商下的模型，也可以逐个勾选。全选 Provider 会自动包含其以后新增的模型；部分选择只匹配当前已列出的模型。这里只管理列表可见性，新增 Provider 或配置密钥仍需在 Pi 中完成。</p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={selectAll} disabled={modelsLoading || availableModels.length === 0} className="rounded-md border border-border px-2.5 py-1.5 text-meta text-text hover:bg-bg-hover disabled:opacity-40">全选</button>
            <button type="button" onClick={() => void restoreDefaults()} disabled={modelsLoading} className="rounded-md border border-border px-2.5 py-1.5 text-meta text-muted hover:bg-bg-hover disabled:opacity-40">恢复默认</button>
          </div>
        </div>
        <div className="mb-3 flex items-center gap-3">
          <input
            value={modelQuery}
            onChange={event => setModelQuery(event.target.value)}
            placeholder="搜索模型或 Provider…"
            aria-label="搜索模型或 Provider"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg-elevated px-3 py-2 text-body-s text-text outline-none focus-ring"
          />
          <span className="shrink-0 text-meta text-muted">已选 {selectedIds.size} / {availableModels.length}</span>
        </div>
        {selectionError && <div role="alert" className="mb-2 text-meta text-danger">{selectionError}</div>}
        {unmatchedPatterns.length > 0 && <div className="mb-2 text-meta text-muted">有 {unmatchedPatterns.length} 条规则暂时没有匹配到当前 Pi 模型目录，保存选择时会保留。</div>}
        {modelsLoading ? (
          <div className="py-4 text-body-s text-muted">读取 Pi 模型列表…</div>
        ) : availableModels.length === 0 ? (
          <div className="py-4 text-body-s text-muted">Pi 当前没有返回可用模型。请先在 Pi 中配置 Provider、凭证或自定义模型。</div>
        ) : modelGroups.length === 0 ? (
          <div className="py-4 text-body-s text-muted">没有匹配「{modelQuery}」的 Provider 或模型。</div>
        ) : (
          <div className="max-h-[min(32rem,60vh)] space-y-3 overflow-y-auto pr-1">
            {modelGroups.map(({ provider, models }) => {
              const enabledCount = models.filter(model => selectedIds.has(modelFullId(model))).length
              const allEnabled = enabledCount === models.length
              const partiallyEnabled = enabledCount > 0 && !allEnabled
              return (
                <section key={provider} className="overflow-hidden rounded-lg border border-border">
                  <label className="flex cursor-pointer items-center gap-2 border-b border-border bg-bg-elevated px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={allEnabled}
                      ref={input => { if (input) input.indeterminate = partiallyEnabled }}
                      onChange={event => selectProvider(provider, event.target.checked)}
                      aria-label={`启用 ${provider} 的全部模型`}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="min-w-0 flex-1 truncate text-body-s font-semibold text-text-strong">{provider}</span>
                    <span className="text-meta text-muted">{enabledCount}/{models.length}</span>
                  </label>
                  <div className="divide-y divide-border">
                    {models.filter(model => {
                      const query = modelQuery.trim().toLowerCase()
                      return !query || provider.toLowerCase().includes(query) || `${model.name || ''} ${model.id}`.toLowerCase().includes(query)
                    }).map(model => {
                      const enabled = selectedIds.has(modelFullId(model))
                      return (
                        <label key={modelFullId(model)} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-bg-hover">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={event => selectModel(model, event.target.checked)}
                            aria-label={`启用 ${provider}/${model.id}`}
                            className="h-4 w-4 shrink-0 accent-accent"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body-s text-text">{model.name || model.id}</span>
                            <span className="block truncate font-mono text-meta text-muted">{model.id}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        )}
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-meta text-muted hover:text-text">高级：手动编辑模型规则</summary>
          <p className="mb-2 mt-2 text-meta text-muted">每行一条 glob 规则，也支持思考强度后缀；清空规则会恢复 Dashboard 默认模型列表。</p>
          <textarea
            className="w-full resize-y rounded-md border border-border bg-bg-elevated p-3 font-mono text-body-s text-text outline-none focus-ring"
            value={(settings.enabledModels || []).join('\n')}
            onChange={event => save({ ...settings, enabledModels: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) })}
            placeholder="anthropic/*&#10;dashscope/kimi-k3:xhigh"
            spellCheck={false}
          />
        </details>
      </Card>
    </div>
  )
}

/* ── BEHAVIOR TAB ── */
function BehaviorTab() {
  const { tr } = useLocale()
  const { settings, feedback, set, setNested } = usePiSettings()
  if (!settings) return <SettingsLoading />

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />

      <Card>
        <CardTitle>{tr('交互方式', 'Interaction Mode')} <InfoTip text={tr('pi 如何处理工具调用与后续消息', 'How pi handles tool calls and follow-up messages')} /></CardTitle>
        <div className="divide-y divide-border">
          <SelectRow
            seg
            label={tr('引导模式', 'Steering mode')}
            hint={tr('多个工具调用如何处理', 'How multiple tool calls are handled')}
            cfg="steeringMode"
            value={settings.steeringMode || 'all'}
            options={[
              { value: 'all', label: tr('一次全部', 'All at once') },
              { value: 'one-at-a-time', label: tr('逐条', 'One at a time') },
            ]}
            onChange={v => set('steeringMode', v)}
          />
          <SelectRow
            seg
            label={tr('后续消息模式', 'Follow-up mode')}
            hint={tr('后续消息如何处理', 'How follow-up messages are processed')}
            cfg="followUpMode"
            value={settings.followUpMode || 'all'}
            options={[
              { value: 'all', label: tr('一次全部', 'All at once') },
              { value: 'one-at-a-time', label: tr('逐条', 'One at a time') },
            ]}
            onChange={v => set('followUpMode', v)}
          />
          <Toggle label={tr('技能命令', 'Skill commands')} hint={tr('在 TUI 中启用 /skill 斜杠命令', 'Enable /skill slash commands in the TUI')} cfg="enableSkillCommands" checked={settings.enableSkillCommands ?? true} onChange={v => set('enableSkillCommands', v)} />
          <Toggle label={tr('安静启动', 'Quiet startup')} hint={tr('隐藏启动横幅和提示信息', 'Suppress startup banners and messages')} cfg="quietStartup" checked={settings.quietStartup ?? false} onChange={v => set('quietStartup', v)} />
          <Toggle label={tr('折叠更新日志', 'Collapse changelog')} hint={tr('启动时自动折叠更新日志', 'Auto-collapse changelog on startup')} cfg="collapseChangelog" checked={settings.collapseChangelog ?? false} onChange={v => set('collapseChangelog', v)} />
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('上下文压缩', 'Compaction')} <InfoTip text={tr('对话过长时自动压缩上下文', 'Automatic context compaction when conversation gets long')} /></CardTitle>
        <div className="divide-y divide-border">
          <Toggle label={tr('启用压缩', 'Enable compaction')} hint={tr('超出上限时自动压缩上下文', 'Automatically compact context when it exceeds limits')} cfg="compaction.enabled" checked={settings.compaction?.enabled ?? true} onChange={v => setNested('compaction', 'enabled', v)} />
          <NumberRow label={tr('预留 token', 'Reserve tokens')} hint={tr('为压缩摘要预留的 token', 'Tokens reserved for compaction summary')} cfg="compaction.reserveTokens" value={settings.compaction?.reserveTokens} onChange={v => setNested('compaction', 'reserveTokens', v)} placeholder="8192" />
          <NumberRow label={tr('保留最近 token', 'Keep recent tokens')} hint={tr('压缩时保留的最近 token', 'Recent tokens preserved during compaction')} cfg="compaction.keepRecentTokens" value={settings.compaction?.keepRecentTokens} onChange={v => setNested('compaction', 'keepRecentTokens', v)} placeholder="4096" />
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('分支摘要', 'Branch Summary')} <InfoTip text={tr('对话分支摘要的设置', 'Settings for conversation branch summaries')} /></CardTitle>
        <div className="divide-y divide-border">
          <Toggle label={tr('跳过摘要确认', 'Skip summary prompt')} hint={tr('跳过分支摘要的确认提示', 'Skip the branch summary confirmation prompt')} cfg="branchSummary.skipPrompt" checked={settings.branchSummary?.skipPrompt ?? false} onChange={v => setNested('branchSummary', 'skipPrompt', v)} />
          <NumberRow label={tr('预留 token', 'Reserve tokens')} hint={tr('为分支摘要预留的 token', 'Tokens reserved for branch summaries')} cfg="branchSummary.reserveTokens" value={settings.branchSummary?.reserveTokens} onChange={v => setNested('branchSummary', 'reserveTokens', v)} placeholder="4096" />
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('重试', 'Retry')} <InfoTip text={tr('API 调用失败时的自动重试行为', 'Automatic retry behavior when API calls fail')} /></CardTitle>
        <div className="divide-y divide-border">
          <Toggle label={tr('启用重试', 'Enable retries')} hint={tr('自动重试失败的 API 请求', 'Automatically retry failed API requests')} cfg="retry.enabled" checked={settings.retry?.enabled ?? true} onChange={v => setNested('retry', 'enabled', v)} />
          <NumberRow label={tr('最大重试次数', 'Max retries')} hint={tr('最多重试多少次', 'Maximum number of retry attempts')} cfg="retry.maxRetries" value={settings.retry?.maxRetries} onChange={v => setNested('retry', 'maxRetries', v)} min={0} max={10} placeholder="3" />
          <NumberRow label={tr('初始延迟（毫秒）', 'Base delay (ms)')} hint={tr('第一次重试前的等待时间', 'Initial delay before first retry')} cfg="retry.baseDelayMs" value={settings.retry?.baseDelayMs} onChange={v => setNested('retry', 'baseDelayMs', v)} min={100} placeholder="1000" />
          <NumberRow label={tr('最大延迟（毫秒）', 'Max delay (ms)')} hint={tr('两次重试之间的最长等待', 'Maximum delay between retries')} cfg="retry.maxDelayMs" value={settings.retry?.maxDelayMs} onChange={v => setNested('retry', 'maxDelayMs', v)} min={100} placeholder="30000" />
        </div>
      </Card>
    </div>
  )
}

/* ── TERMINAL TAB ── */
function TerminalTab() {
  const { settings, feedback, set, setNested } = usePiSettings()
  if (!settings) return <SettingsLoading />

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />

      <Card>
        <CardTitle>Shell <InfoTip text="Shell and command settings for the TUI terminal" /></CardTitle>
        <div className="divide-y divide-border">
          <TextRow label="Shell path" hint="Path to the shell binary (e.g. /bin/zsh)" value={settings.shellPath || ''} onChange={v => set('shellPath', v || undefined)} placeholder="/bin/bash" mono />
          <TextRow label="Shell command prefix" hint="Prefix prepended to all shell commands" value={settings.shellCommandPrefix || ''} onChange={v => set('shellCommandPrefix', v || undefined)} placeholder="e.g. source ~/.profile &&" mono />
        </div>
      </Card>

      <Card>
        <CardTitle>TUI Display <InfoTip text="Terminal UI rendering options" /></CardTitle>
        <div className="divide-y divide-border">
          <Toggle label="Show images" hint="Render images inline in the TUI (iTerm2/Kitty)" checked={settings.terminal?.showImages ?? true} onChange={v => setNested('terminal', 'showImages', v)} />
          <Toggle label="Clear on shrink" hint="Clear screen when terminal shrinks" checked={settings.terminal?.clearOnShrink ?? false} onChange={v => setNested('terminal', 'clearOnShrink', v)} />
          <Toggle label="Show hardware cursor" hint="Use terminal's native cursor instead of TUI cursor" checked={settings.showHardwareCursor ?? false} onChange={v => set('showHardwareCursor', v)} />
          <NumberRow label="Editor padding X" hint="Horizontal padding in the editor (columns)" value={settings.editorPaddingX} onChange={v => set('editorPaddingX', v)} min={0} max={20} placeholder="2" />
          <NumberRow label="Autocomplete max visible" hint="Max suggestions shown in autocomplete dropdown" value={settings.autocompleteMaxVisible} onChange={v => set('autocompleteMaxVisible', v)} min={1} max={30} placeholder="8" />
        </div>
      </Card>

      <Card>
        <CardTitle>Images <InfoTip text="How images are handled in conversations" /></CardTitle>
        <div className="divide-y divide-border">
          <Toggle label="Auto-resize images" hint="Automatically resize large images before sending" checked={settings.images?.autoResize ?? true} onChange={v => setNested('images', 'autoResize', v)} />
          <Toggle label="Block images" hint="Prevent images from being sent to the model entirely" checked={settings.images?.blockImages ?? false} onChange={v => setNested('images', 'blockImages', v)} />
        </div>
      </Card>

      <Card>
        <CardTitle>Keyboard & Navigation <InfoTip text="TUI keyboard behavior" /></CardTitle>
        <div className="divide-y divide-border">
          <SelectRow
            label="Double-Escape action"
            hint="What happens when you press Escape twice"
            value={settings.doubleEscapeAction || 'fork'}
            options={[
              { value: 'fork', label: 'Fork conversation' },
              { value: 'tree', label: 'Show tree' },
              { value: 'none', label: 'None' },
            ]}
            onChange={v => set('doubleEscapeAction', v)}
          />
          <SelectRow
            label="Tree filter mode"
            hint="Default filter for the conversation tree view"
            value={settings.treeFilterMode || 'default'}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'no-tools', label: 'No tools' },
              { value: 'user-only', label: 'User only' },
              { value: 'labeled-only', label: 'Labeled only' },
              { value: 'all', label: 'All messages' },
            ]}
            onChange={v => set('treeFilterMode', v)}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>Markdown <InfoTip text="Markdown rendering options" /></CardTitle>
        <div className="divide-y divide-border">
          <TextRow label="Code block indent" hint="Indentation string for code blocks" value={settings.markdown?.codeBlockIndent || ''} onChange={v => setNested('markdown', 'codeBlockIndent', v || undefined)} placeholder="  " mono />
        </div>
      </Card>
    </div>
  )
}

/* ── GENERAL TAB (packages) ── */
function GeneralTab() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<PiSettings | null>(null)

  useEffect(() => {
    fetch('/api/pi/settings').then(j).then(setSettings).catch(() => {})
  }, [])

  if (!settings) return <SettingsLoading />

  // Resource paths
  const resourceSections: { key: keyof PiSettings; label: string; hint: string; placeholder: string }[] = [
    { key: 'extensions', label: 'Extension Paths', hint: 'Paths to custom pi extensions', placeholder: './my-extension' },
    { key: 'skills', label: 'Skill Paths', hint: 'Paths to custom skill directories', placeholder: './my-skills/' },
    { key: 'prompts', label: 'Prompt Template Paths', hint: 'Paths to custom prompt templates', placeholder: './prompts/' },
    { key: 'themes', label: 'Theme Paths', hint: 'Paths to custom TUI themes', placeholder: './my-theme.json' },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Extensions &amp; Packages <InfoTip text="安装/卸载/更新、启停、排序、配置、审计与回滚集中在 Extensions 页" /></CardTitle>
        <div className="flex flex-wrap items-center gap-3 py-1">
          <span className="text-body-s text-muted">
            包与扩展的管理（安装 npm/git/本地路径、启停、排序、配置面板、操作审计与回滚）已集中到 Extensions 页。
            这里只保留 <span className="text-text">Pi 的设置字段</span>（下方路径类配置）。
          </span>
          <button
            type="button"
            onClick={() => navigate('/extensions#install')}
            className="shrink-0 rounded-md border border-accent px-3 py-1.5 text-meta font-medium text-accent transition hover:bg-accent hover:text-accent-fg"
          >
            打开 Extensions → 安装新扩展
          </button>
        </div>
      </Card>

      {/* Resource paths */}
      {resourceSections.map(({ key, label, hint, placeholder }) => (
        <Card key={key}>
          <CardTitle>{label} <InfoTip text={hint} /></CardTitle>
          <textarea
            className="w-full bg-bg-elevated border border-border rounded-md p-3 text-body-s font-mono text-text resize-none outline-none focus-ring leading-relaxed min-h-[60px]"
            value={((settings[key] as string[]) || []).join('\n')}
            onChange={e => {
              const lines = e.target.value.split('\n').filter(l => l.trim())
              const next = { ...settings, [key]: lines.length ? lines : undefined }
              setSettings(next)
            }}
            onBlur={() => {
              void putJson('/api/pi/settings', settings)
            }}
            placeholder={placeholder}
            spellCheck={false}
          />
        </Card>
      ))}

      {/* Plugin-contributed settings sections */}
      <SettingsSectionSlot tab="general" />
    </div>
  )
}

/* ── CHAT TAB ── */
function ChatTab() {
  const { tr } = useLocale()
  const [config, setConfig] = useState<ChatConfig>(loadChatConfig)

  const set = <K extends keyof ChatConfig>(k: K, v: ChatConfig[K]) => {
    const next = { ...config, [k]: v }
    saveChatConfig(next)
    setConfig(next)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>{tr('对话行为', 'Chat Behavior')}</CardTitle>
        <div className="divide-y divide-border">
          <Toggle label={tr('显示消息时间', 'Show message timestamps')} hint={tr('在每条消息旁显示时间', 'Display time next to each message')} cfg="showTimestamps" checked={config.showTimestamps} onChange={v => set('showTimestamps', v)} />
          <Toggle label={tr('按 Enter 发送', 'Send on Enter')} hint={config.sendOnEnter ? tr('Shift+Enter 换行', 'Shift+Enter for newline') : tr('点击发送按钮提交', 'Click Send button to submit')} cfg="sendOnEnter" checked={config.sendOnEnter} onChange={v => set('sendOnEnter', v)} />
          <Toggle label={tr('默认展开历史', 'History expanded by default')} hint={tr('自动展开侧栏中的会话历史', 'Auto-expand session history in sidebar')} cfg="historyExpanded" checked={config.historyExpanded} onChange={v => set('historyExpanded', v)} />
          <SelectRow seg label={tr('通知数量上限', 'Notification limit')} hint={tr('最多保留的通知条数', 'Max notifications to keep')} cfg="notifLimit" value={String(config.notifLimit)} options={[
            { value: '25', label: '25' }, { value: '50', label: '50' },
            { value: '100', label: '100' }, { value: '200', label: '200' },
          ]} onChange={v => set('notifLimit', Number(v))} />
        </div>
      </Card>
    </div>
  )
}

/* ── DISPLAY TAB ── */
/* ── Voice output (TTS) ── */

/** Voice-input recognition languages offered in Settings (transcribed on the backend). */
const STT_LANGUAGES = ASR_LANGUAGES.map(language => ({
  value: language.id,
  label: language.id === 'zh' ? `${language.label}（默认）` : language.label,
}))

function VoiceTab() {
  const [config, setConfig] = useState<TtsSettings>(loadTtsSettings)
  const [catalog, setCatalog] = useState<TtsConfigResponse | null>(null)
  const [asrCatalog, setAsrCatalog] = useState<AsrConfigResponse | null>(null)
  const [testText, setTestText] = useState('你好，这是语音输出试听。')
  const voice = useVoiceOutput()

  useEffect(() => {
    let cancelled = false
    fetch('/api/tts/config')
      .then(r => (r.ok ? r.json() : undefined))
      .then((data: TtsConfigResponse | undefined) => { if (!cancelled && data) setCatalog(data) })
      .catch(() => {})
    fetch('/api/asr/config')
      .then(r => (r.ok ? r.json() : undefined))
      .then((data: AsrConfigResponse | undefined) => { if (!cancelled && data) setAsrCatalog(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const models = catalog?.models ?? TTS_MODELS
  const voices = catalog?.voices ?? TTS_VOICES
  const languages = catalog?.languages ?? TTS_LANGUAGES

  const set = <K extends keyof TtsSettings>(k: K, v: TtsSettings[K]) => {
    const next = { ...config, [k]: v }
    saveTtsSettings(next)
    setConfig(next)
  }

  const knownModel = models.some(m => m.id === config.model)
  const knownVoice = voices.some(v => v.id === config.voice)
  const supportsInstructions = models.find(m => m.id === config.model)?.supportsInstructions === true

  return (
    <div className="space-y-4">
      {catalog && !catalog.available && (
        <div className="rounded-md border border-warn bg-warn-subtle px-3 py-2 text-body-s text-warn">
          {catalog.reason || '语音输出当前不可用。'} 需要环境变量 <code className="font-mono">DASHSCOPE_API_KEY</code>（区域：{catalog.endpoint}）。
        </div>
      )}

      <Card>
        <CardTitle>语音输出（Live Session）</CardTitle>
        <div className="divide-y divide-border">
          <Toggle
            label="回复结束自动朗读"
            hint="Pi 一轮回复结束时朗读最后一条回复；可在 Live Session 顶栏临时切换"
            checked={config.enabled}
            onChange={v => set('enabled', v)}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>语音模型</CardTitle>
        <div className="divide-y divide-border">
          <SelectRow
            label="模型"
            hint="默认使用 DashScope 的 Qwen-TTS"
            value={knownModel ? config.model : '__custom__'}
            options={[...models.map(m => ({ value: m.id, label: m.label })), { value: '__custom__', label: '自定义模型 ID…' }]}
            onChange={v => set('model', v === '__custom__' ? '' : v)}
          />
          {!knownModel && (
            <TextRow
              label="自定义模型 ID"
              hint="留空则回退到默认模型"
              value={config.model}
              onChange={v => set('model', v)}
              placeholder={catalog?.defaultModel || TTS_MODELS[0].id}
              mono
            />
          )}
          <SelectRow
            label="音色"
            value={knownVoice ? config.voice : '__custom__'}
            options={[...voices.map(v => ({ value: v.id, label: v.hint ? `${v.label} · ${v.hint}` : v.label })), { value: '__custom__', label: '自定义音色 ID…' }]}
            onChange={v => set('voice', v === '__custom__' ? '' : v)}
          />
          {!knownVoice && (
            <TextRow
              label="自定义音色 ID"
              hint="留空则回退到默认音色"
              value={config.voice}
              onChange={v => set('voice', v)}
              placeholder={catalog?.defaultVoice || TTS_VOICES[0].id}
              mono
            />
          )}
          <SelectRow
            label="语种"
            hint="自动时由模型按文本判断"
            value={config.languageType}
            options={languages.map(l => ({ value: l.id, label: l.label }))}
            onChange={v => set('languageType', v)}
          />
          {supportsInstructions && (
            <TextRow
              label="风格指令"
              hint="仅 Instruct 模型支持，如“语速稍快、语气亲切”"
              value={config.instructions}
              onChange={v => set('instructions', v)}
              placeholder="可选"
            />
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>语音输入（听写）</CardTitle>
        <div className="divide-y divide-border">
          {asrCatalog && !asrCatalog.available && (
            <div className="py-2 text-body-s text-warn">{asrCatalog.reason || '语音输入当前不可用。'}</div>
          )}
          <SelectRow
            label="识别语言"
            hint={`由后端 DashScope 实时识别（${asrCatalog?.defaultModel ?? ASR_REALTIME_MODEL}，当前：${asrLanguageLabel(config.sttLanguage)}），需浏览器支持麦克风和实时音频`}
            value={config.sttLanguage}
            options={STT_LANGUAGES}
            onChange={v => set('sttLanguage', v)}
          />
        </div>
      </Card>

      <Card>
        <CardTitle>试听</CardTitle>
        <div className="space-y-3">
          <textarea
            className="w-full resize-y rounded-md border border-border bg-bg-elevated px-3 py-2 text-body-s text-text outline-none transition-colors focus-ring"
            rows={2}
            value={testText}
            onChange={e => setTestText(e.target.value)}
            placeholder="输入要朗读的文本"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!testText.trim() || voice.speaking}
              onClick={() => { void voice.speak(testText, config) }}
              className="rounded-md border border-accent bg-accent px-3 py-1.5 text-meta text-accent-fg transition-opacity disabled:opacity-50"
            ><MaterialIcon name="volume_up" className="inline h-3.5 w-3.5 align-[-2px]" /> 试听</button>
            {voice.speaking && (
              <button type="button" onClick={voice.stop} className="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-3 py-1.5 text-meta text-muted"><MaterialIcon name="stop" className="h-3 w-3" />停止</button>
            )}
            <span className="text-meta text-muted opacity-60">长回复会自动分段朗读（每段约 400 字）</span>
          </div>
          {voice.error && (
            <div className="flex items-center gap-2">
              <Feedback feedback={{ type: 'err', msg: voice.error }} />
              <button type="button" onClick={voice.clearError} className="shrink-0 rounded border border-border bg-bg px-2 py-0.5 text-2xs text-muted">关闭</button>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

function DisplayTab() {
  const { tr } = useLocale()
  const { theme, preference, setTheme } = useTheme()
  const customStyle = useCustomStyle()
  const [newName, setNewName] = useState('')
  const [editName, setEditName] = useState<string | null>(null)
  const [editCss, setEditCss] = useState('')

  // Build unified theme list: built-in + custom
  const builtinCards = [
    { id: 'system', label: tr('系统', 'System'), css: BUILTIN_THEMES[theme] || BUILTIN_THEMES.dark, builtin: true },
    ...THEMES.map(t => ({ id: t.id, label: t.label, css: BUILTIN_THEMES[t.id], builtin: true })),
  ]
  const customCards = customStyle.styles.map(name => ({
    id: `custom:${name}`, label: name, css: customStyle.styleContents[name] || '', builtin: false, name,
  }))
  const allCards = [...builtinCards, ...customCards]

  const activeBuiltin = preference
  const activeCustom = customStyle.active

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>{tr('主题', 'Themes')}</CardTitle>
        <div className="grid grid-cols-3 gap-2 py-3">
          {allCards.map(card => {
            const vars = parseVars(card.css)
            const bg = vars['bg'] || '#12141a'
            const accent = vars['accent'] || '#7aa2f7'
            const text = vars['text'] || '#e4e4e7'
            const cardColor = vars['card'] || vars['bg-accent'] || '#181b22'
            const isActive = card.builtin
              ? activeBuiltin === card.id && !activeCustom
              : activeCustom === (card as any).name
            return (
              <button
                key={card.id}
                className={`group relative px-3 py-2.5 rounded-lg text-body-s font-medium border cursor-pointer transition text-left ${isActive ? 'bg-accent-subtle text-accent border-accent shadow-sm' : 'border-border text-muted bg-transparent hover:text-text hover:border-border-strong'}`}
                onClick={() => {
                  if (card.builtin) {
                    setTheme(card.id as ThemeId | 'system')
                    if (activeCustom) customStyle.activate('')
                  } else {
                    customStyle.activate(isActive ? '' : (card as any).name)
                  }
                }}
              >
                <div className="flex gap-1 mb-1.5">
                  {[bg, cardColor, accent, text].map((c, i) => (
                    <span key={i} className="w-3 h-3 rounded-full border border-white/10 shrink-0" style={{ background: c }} />
                  ))}
                </div>
                <div className="text-meta truncate">{card.label}</div>
                {!card.builtin && <span className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-2xs text-muted hover:text-danger transition-opacity" onClick={e => { e.stopPropagation(); if (confirm(tr(`删除“${(card as any).name}”？`, `Delete "${(card as any).name}"?`))) customStyle.remove((card as any).name) }}>✕</span>}
              </button>
            )
          })}
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('字体', 'Font')}</CardTitle>
        <div className="text-body-s text-muted py-3">
          {tr('正文', 'Body')}: <span className="font-mono text-text">Space Grotesk</span> · {tr('代码', 'Code')}: <span className="font-mono text-text">JetBrains Mono</span>
        </div>
      </Card>

      <Card>
        <CardTitle>{tr('自定义样式', 'Custom Styles')}</CardTitle>
        <div className="divide-y divide-border">
          {customStyle.active && (
            <div className="py-2">
              <button className="text-meta text-accent cursor-pointer bg-transparent border-none hover:underline" onClick={() => { if (editName === customStyle.active) { setEditName(null) } else { setEditName(customStyle.active); setEditCss(customStyle.styleContents[customStyle.active] || '') } }}>{editName === customStyle.active ? tr('▾ 关闭编辑器', '▾ Close editor') : tr('▸ 编辑 CSS', '▸ Edit CSS')}</button>
              {editName === customStyle.active && (
                <div className="mt-2">
                  <textarea className="w-full h-48 bg-bg-elevated border border-border rounded-md px-3 py-2 text-body-s font-mono text-text outline-none resize-y focus-ring" value={editCss} onChange={e => setEditCss(e.target.value)} />
                  <button className="mt-1 px-3 py-1.5 rounded-md text-body-s font-medium bg-accent text-accent-fg border-none cursor-pointer hover:bg-accent-hover transition" onClick={() => { customStyle.save(editName!, editCss); setEditName(null) }}>{tr('保存', 'Save')}</button>
                </div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 py-2">
            <input className="flex-1 bg-bg-elevated border border-border rounded-md px-3 py-1.5 text-body-s text-text font-body outline-none focus-ring" placeholder={tr('新样式名称…', 'New style name…')} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { customStyle.save(newName.trim(), `/* ${newName.trim()} */\n:root {\n  /* Override CSS variables here */\n}\n`); customStyle.activate(newName.trim()); setNewName('') } }} />
            <button className="px-3 py-1.5 rounded-md text-body-s font-medium border border-accent text-accent bg-transparent cursor-pointer hover:bg-accent hover:text-accent-fg transition disabled:opacity-30" disabled={!newName.trim()} onClick={() => { if (newName.trim()) { customStyle.save(newName.trim(), `/* ${newName.trim()} */\n:root {\n  /* Override CSS variables here */\n}\n`); customStyle.activate(newName.trim()); setNewName('') } }}>{tr('创建', 'Create')}</button>
          </div>
          <div className="py-3 text-2xs text-muted">{tr('提示：若自定义样式弄坏了界面，在网址后加 ', 'Tip: add ')}<code className="font-mono">?reset-css=true</code>{tr(' 即可停用自定义样式。', ' to the URL to disable custom styles if they break the UI.')}</div>
        </div>
      </Card>
    </div>
  )
}

/* ── SKILLS TAB ── */
function SkillsTab() {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)

  useEffect(() => { fetch('/api/skills').then(r => r.json()).then(setSkills).catch(() => {}) }, [])

  const selectSkill = useCallback(async (name: string) => {
    setSelected(name)
    setOpenFile(null)
    setContent('')
    setDirty(false)
    try {
      const d = await fetch(`/api/skills/${encodeURIComponent(name)}/files`).then(r => r.json())
      setFiles(d.files || [])
    } catch { setFiles([]) }
  }, [])

  const openSkillFile = useCallback(async (file: string) => {
    if (!selected) return
    setOpenFile(file)
    setDirty(false)
    try {
      const d = await fetch(`/api/skills/${encodeURIComponent(selected)}/file?path=${encodeURIComponent(file)}`).then(r => r.json())
      setContent(d.content || '')
    } catch { setContent('') }
  }, [selected])

  const save = useCallback(async () => {
    if (!selected || !openFile) return
    setSaving(true)
    try {
      await fetch(`/api/skills/${encodeURIComponent(selected)}/file`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: openFile, content }),
      }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) })
      setDirty(false)
      setFeedback({ type: 'ok', msg: 'Saved' })
    } catch (e: any) { setFeedback({ type: 'err', msg: e.message || 'Save failed' }) }
    setSaving(false)
    setTimeout(() => setFeedback(null), 2000)
  }, [selected, openFile, content])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirty) { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dirty, save])

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />
      <Card>
        <CardTitle>Skills <InfoTip text="Edit SKILL.md files and scripts in ~/.pi/agent/skills/" /></CardTitle>
        <div className="flex flex-col md:flex-row gap-4 min-h-[400px]">
          <div className="w-full md:w-48 shrink-0 md:border-r border-b md:border-b-0 border-border pb-3 md:pb-0 md:pr-3 overflow-y-auto max-h-[200px] md:max-h-[500px]">
            {skills.map(s => (
              <button key={s.name} onClick={() => selectSkill(s.name)}
                className={`w-full text-left px-2 py-1.5 rounded text-body-s font-mono truncate cursor-pointer transition-colors ${
                  selected === s.name ? 'bg-accent-subtle text-accent' : 'text-text hover:bg-bg-hover'
                }`}
                title={s.description}
              >{s.name}</button>
            ))}
          </div>
          <div className="flex-1 min-w-0">
            {!selected ? (
              <div className="text-body-s text-muted py-8 text-center">Select a skill to view its files</div>
            ) : !openFile ? (
              <div>
                <div className="text-body-s text-muted mb-2">Files in <span className="font-mono text-text">{selected}/</span></div>
                {files.map(f => (
                  <button key={f} onClick={() => openSkillFile(f)}
                    className="block w-full text-left px-2 py-1.5 rounded text-body-s font-mono text-accent hover:bg-bg-hover cursor-pointer transition-colors truncate"
                  >{f}</button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 mb-2">
                  <button onClick={() => { setOpenFile(null); setDirty(false) }}
                    className="text-meta text-muted hover:text-text cursor-pointer">← back</button>
                  <span className="text-body-s font-mono text-text truncate">{selected}/{openFile}</span>
                  {dirty && <span className="text-2xs text-warning">●</span>}
                  <button onClick={save} disabled={!dirty || saving}
                    className="ml-auto px-3 py-1 rounded-md text-meta font-medium border border-accent text-accent bg-transparent cursor-pointer hover:bg-accent hover:text-accent-fg transition disabled:opacity-30"
                  >{saving ? '⏳' : '💾'} Save</button>
                </div>
                <textarea
                  className="flex-1 min-h-[350px] w-full bg-bg-elevated border border-border rounded-md p-3 text-body-s font-mono text-text resize-none outline-none focus-ring leading-relaxed"
                  value={content}
                  onChange={e => { setContent(e.target.value); setDirty(true) }}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

/* ── VAULT TAB ── */
interface DashConfig {
  vault: {
    path: string
    dirs: {
      daily: string
      tasks: string
      meetings: string
      people: string
      recipes: string
    }
  }
  tasks?: {
    enabled: boolean
    journal: { autoDetect: boolean; roots: string[]; enabled: boolean }
    defaultView?: 'execute' | 'survey'
    providers?: unknown[]
    lanes?: unknown
  }
}

const LARK_INPUT_CLS = 'w-full bg-bg-elevated border border-border rounded-md px-3 py-2 text-body-s text-text outline-none focus-ring transition-colors'
const LARK_BTN_CLS = 'px-3 py-2 rounded-md text-body-s font-medium border border-accent text-accent bg-transparent cursor-pointer hover:bg-accent hover:text-accent-fg transition disabled:opacity-30'
const LARK_BTN_SM = 'px-2 py-1 rounded text-meta border border-border text-muted bg-transparent cursor-pointer hover:text-text transition disabled:opacity-30'

interface LarkAccountPublic { id: string; name: string; appId: string; domain: string; appSecretMasked: string; createdAt: string }
const LARK_DOMAIN_LABELS: Record<string, string> = { feishu: '飞书', lark: 'Lark 国际' }
interface LarkAccountsPayload { activeId: string | null; accounts: LarkAccountPublic[]; allowedUserIds?: string[] }

function LarkTab() {
  const [payload, setPayload] = useState<LarkAccountsPayload | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)
  const [form, setForm] = useState<{ id?: string; name: string; appId: string; appSecret: string; domain: 'feishu' | 'lark' }>({ name: '', appId: '', appSecret: '', domain: 'feishu' })
  const [busy, setBusy] = useState(false)
  const [allowedText, setAllowedText] = useState('')

  const load = useCallback(async () => {
    try {
      const data = (await fetch('/api/lark/accounts').then(j)) as LarkAccountsPayload
      setPayload(data)
      setAllowedText((data.allowedUserIds || []).join('\n'))
    } catch {
      setFeedback({ type: 'err', msg: '加载失败' })
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const notify = (value: { type: 'ok' | 'err'; msg: string }) => {
    setFeedback(value)
    setTimeout(() => setFeedback(null), 2500)
  }

  const request = async (url: string, method: string, body?: object): Promise<unknown> => {
    setBusy(true)
    try {
      return await fetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      }).then(j)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!form.appId.trim()) return notify({ type: 'err', msg: 'App ID 必填' })
    try {
      await request('/api/lark/accounts', 'PUT', { id: form.id, name: form.name, appId: form.appId, domain: form.domain, appSecret: form.appSecret || undefined })
      setForm({ name: '', appId: '', appSecret: '', domain: 'feishu' })
      await load()
      notify({ type: 'ok', msg: '已保存' })
    } catch {
      notify({ type: 'err', msg: '保存失败（检查 App ID / Secret）' })
    }
  }

  const remove = async (id: string) => {
    try { await request(`/api/lark/accounts/${id}`, 'DELETE'); await load(); notify({ type: 'ok', msg: '已删除' }) }
    catch { notify({ type: 'err', msg: '删除失败' }) }
  }

  const activate = async (id: string) => {
    try { await request(`/api/lark/accounts/${id}/activate`, 'POST'); await load(); notify({ type: 'ok', msg: '已设为启用（网关自动生效）' }) }
    catch { notify({ type: 'err', msg: '切换失败' }) }
  }

  const verify = async (id: string) => {
    try { await request(`/api/lark/accounts/${id}/verify`, 'POST'); notify({ type: 'ok', msg: '凭证有效' }) }
    catch { notify({ type: 'err', msg: '凭证校验失败' }) }
  }

  const saveAllowed = async () => {
    try {
      await request('/api/lark/allowed-users', 'PUT', { allowedUserIds: allowedText })
      await load()
      notify({ type: 'ok', msg: '白名单已保存（网关自动生效）' })
    } catch {
      notify({ type: 'err', msg: '保存失败' })
    }
  }

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />

      <Card>
        <CardTitle>
          Lark / 飞书机器人账号
          <InfoTip text="在飞书开放平台创建企业自建应用，开启长连接事件订阅（im.message.receive_v1）并添加机器人能力。同一时刻只有一个账号启用；切换后网关自动生效，无需重启。" />
        </CardTitle>
        {!payload ? (
          <div className="text-muted text-body-s py-2">Loading…</div>
        ) : payload.accounts.length === 0 ? (
          <div className="text-muted text-body-s py-2">尚未配置账号。在下方添加 App ID / App Secret。</div>
        ) : (
          <div className="space-y-2">
            {payload.accounts.map(account => (
              <div key={account.id} className="flex items-center gap-3 border border-border rounded-md px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="text-body-s text-text truncate">
                    {account.name}
                    {payload.activeId === account.id && <span className="ml-1 text-accent">● 启用中</span>}
                  </div>
                  <div className="text-meta text-muted font-mono truncate">{account.appId} · {LARK_DOMAIN_LABELS[account.domain] || account.domain} · {account.appSecretMasked || '—'}</div>
                </div>
                <button className={LARK_BTN_SM} disabled={busy || payload.activeId === account.id} onClick={() => void activate(account.id)}>启用</button>
                <button className={LARK_BTN_SM} disabled={busy} onClick={() => void verify(account.id)}>测试</button>
                <button className={LARK_BTN_SM} disabled={busy} onClick={() => setForm({ id: account.id, name: account.name, appId: account.appId, appSecret: '', domain: account.domain === 'lark' ? 'lark' : 'feishu' })}>编辑</button>
                <button className={LARK_BTN_SM} disabled={busy} onClick={() => void remove(account.id)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>{form.id ? '编辑账号' : '新增账号'}</CardTitle>
        <div className="space-y-2">
          <input className={LARK_INPUT_CLS} placeholder="名称（如：工作机器人）" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <select className={LARK_INPUT_CLS} value={form.domain} onChange={e => setForm({ ...form, domain: e.target.value === 'lark' ? 'lark' : 'feishu' })}>
            <option value="feishu">飞书（open.feishu.cn）</option>
            <option value="lark">Lark 国际版（open.larksuite.com）</option>
          </select>
          <input className={LARK_INPUT_CLS} placeholder="App ID（cli_xxx）" value={form.appId} onChange={e => setForm({ ...form, appId: e.target.value })} />
          <input className={LARK_INPUT_CLS} type="password" placeholder={form.id ? 'App Secret（留空则不修改）' : 'App Secret'} value={form.appSecret} onChange={e => setForm({ ...form, appSecret: e.target.value })} />
          <div className="flex gap-2">
            <button className={LARK_BTN_CLS} disabled={busy || !form.appId.trim()} onClick={() => void save()}>💾 保存</button>
            {form.id && <button className={LARK_BTN_SM} onClick={() => setForm({ name: '', appId: '', appSecret: '', domain: 'feishu' })}>取消</button>}
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>
          允许的用户（白名单）
          <InfoTip text="只有名单内的用户能驱动机器人（群聊里也只认名单内的人）。留空 = 不限制，任何人都能用。每行一个 open_id / user_id，也可用逗号分隔。保存后网关自动生效，无需重启。" />
        </CardTitle>
        <div className="space-y-2">
          <textarea
            className={`${LARK_INPUT_CLS} font-mono min-h-[72px]`}
            placeholder={'ou_xxxxxxxx（每行一个，或用逗号分隔）\n留空 = 不限制，任何人都能使用机器人'}
            value={allowedText}
            onChange={e => setAllowedText(e.target.value)}
          />
          <div className="text-meta text-muted">
            当前状态：{allowedText.trim() ? '🔒 已限制为名单内用户' : '⚠️ 不限制（任何人可用）'}
          </div>
          <button className={LARK_BTN_CLS} disabled={busy} onClick={() => void saveAllowed()}>💾 保存白名单</button>
        </div>
      </Card>
    </div>
  )
}

function VaultTab() {
  const [config, setConfig] = useState<DashConfig | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/dash/config').then(j).then(setConfig).catch(() => {})
  }, [])

  const save = useCallback(async (next: DashConfig) => {
    setSaving(true)
    setConfig(next)
    try {
      const result = await putJson('/api/dash/config', next)
      if (!result.ok) {
        setFeedback({ type: 'err', msg: result.hint ? `未保存：${result.error} —— ${result.hint}` : `未保存：${result.error}` })
        return
      }
      setConfig(next)
      setFeedback({ type: 'ok', msg: 'Saved' })
    } catch {
      setFeedback({ type: 'err', msg: 'Save failed' })
    }
    setSaving(false)
    setTimeout(() => setFeedback(null), 2000)
  }, [])

  if (!config) return <div className="text-muted text-body-s py-4">Loading…</div>

  const setVaultPath = (path: string) => save({ ...config, vault: { ...config.vault, path } })
  const setDir = (key: string, value: string) => save({ ...config, vault: { ...config.vault, dirs: { ...config.vault.dirs, [key]: value } } })

  const dirFields: { key: string; label: string; hint: string }[] = [
    { key: 'daily', label: 'Daily Notes', hint: 'Folder containing daily .md files (e.g. 2026-04-17.md)' },
    { key: 'tasks', label: 'Task Notes', hint: 'Folder containing task notes' },
    { key: 'meetings', label: 'Meeting Notes', hint: 'Folder containing meeting notes' },
    { key: 'people', label: 'People', hint: 'Folder containing person notes' },
    { key: 'recipes', label: 'Recipes', hint: 'Folder containing recipes' },
  ]

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />

      <Card>
        <CardTitle>Obsidian Vault Path <InfoTip text="Absolute path to your Obsidian vault directory. Leave empty to disable vault features." /></CardTitle>
        <div className="flex gap-2">
          <input
            className="flex-1 bg-bg-elevated border border-border rounded-md px-3 py-2 text-body-s font-mono text-text outline-none focus-ring transition-colors"
            placeholder="/Users/you/Documents/MyVault"
            value={config.vault.path}
            onChange={e => setConfig({ ...config, vault: { ...config.vault, path: e.target.value } })}
            onBlur={e => {
              const trimmed = e.target.value.trim()
              if (trimmed !== config.vault.path) setVaultPath(trimmed)
            }}
            onKeyDown={e => { if (e.key === 'Enter') setVaultPath((e.target as HTMLInputElement).value.trim()) }}
          />
          <button
            className="px-3 py-2 rounded-md text-body-s font-medium border border-accent text-accent bg-transparent cursor-pointer hover:bg-accent hover:text-accent-fg transition disabled:opacity-30"
            disabled={saving}
            onClick={() => setVaultPath(config.vault.path.trim())}
          >
            {saving ? '⏳' : '💾'} Save
          </button>
        </div>
        {config.vault.path && (
          <div className="text-meta text-muted mt-2">Stored in <span className="font-mono">~/.pi/dashboard.json</span></div>
        )}
      </Card>

      <Card>
        <CardTitle>Subdirectory Mapping <InfoTip text="Map vault features to the folder names in your vault. Paths are relative to the vault root." /></CardTitle>
        <div className="divide-y divide-border">
          {dirFields.map(({ key, label, hint }) => (
            <div key={key} className="flex items-center justify-between gap-4 py-2.5">
              <div>
                <span className="text-body-s text-text">{label}</span>
                <div className="text-meta text-muted opacity-60 mt-0.5">{hint}</div>
              </div>
              <input
                className="w-48 bg-bg-elevated border border-border rounded-md px-2.5 py-1.5 text-body-s font-mono text-text outline-none focus-ring transition-colors text-right"
                value={(config.vault.dirs as any)[key] || ''}
                onChange={e => setConfig({ ...config, vault: { ...config.vault, dirs: { ...config.vault.dirs, [key]: e.target.value } } })}
                onBlur={e => setDir(key, e.target.value.trim())}
                onKeyDown={e => { if (e.key === 'Enter') setDir(key, (e.target as HTMLInputElement).value.trim()) }}
              />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

/* ── DEVELOPER TAB ── */
function TasksTab() {
  const [config, setConfig] = useState<DashConfig | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [rootsText, setRootsText] = useState('')
  const [providersText, setProvidersText] = useState('[]')
  const [provErr, setProvErr] = useState('')

  useEffect(() => {
    fetch('/api/dash/config').then(j).then((c: DashConfig) => {
      setConfig(c)
      setRootsText((c.tasks?.journal?.roots ?? []).join('\n'))
      setProvidersText(JSON.stringify(c.tasks?.providers ?? [], null, 2))
    }).catch(() => {})
  }, [])

  const save = useCallback(async (next: DashConfig) => {
    setSaving(true)
    setConfig(next)
    try {
      const result = await putJson('/api/dash/config', next)
      if (!result.ok) {
        setFeedback({ type: 'err', msg: result.hint ? `未保存：${result.error} —— ${result.hint}` : `未保存：${result.error}` })
        return
      }
      const saved = next as DashConfig
      setConfig(saved)
      setRootsText((saved.tasks?.journal?.roots ?? []).join('\n'))
      setProvidersText(JSON.stringify(saved.tasks?.providers ?? [], null, 2))
      setFeedback({ type: 'ok', msg: 'Saved' })
    } catch {
      setFeedback({ type: 'err', msg: 'Save failed' })
    }
    setSaving(false)
    setTimeout(() => setFeedback(null), 2000)
  }, [])

  if (!config) return <div className="text-muted text-body-s py-4">Loading…</div>

  const tasks = config.tasks ?? { enabled: true, journal: { autoDetect: true, roots: [], enabled: true }, defaultView: 'execute' as const }
  const journal = tasks.journal ?? { autoDetect: true, roots: [], enabled: true }
  const setTasks = (patch: Partial<NonNullable<DashConfig['tasks']>>) => save({ ...config, tasks: { ...tasks, ...patch } })
  const setJournal = (patch: Partial<NonNullable<DashConfig['tasks']>['journal']>) => setTasks({ journal: { ...journal, ...patch } })
  const saveRoots = () => {
    const roots = rootsText.split('\n').map(s => s.trim()).filter(Boolean)
    if (JSON.stringify(roots) !== JSON.stringify(journal.roots)) setJournal({ roots })
  }
  const saveProviders = () => {
    let parsed: unknown
    try { parsed = JSON.parse(providersText || '[]') } catch (e) { setProvErr('JSON 解析失败：' + (e as Error).message); return }
    if (!Array.isArray(parsed)) { setProvErr('必须是数组'); return }
    setProvErr('')
    setTasks({ providers: parsed })
  }

  return (
    <div className="space-y-4">
      <Feedback feedback={feedback} />
      {saving && <div className="text-2xs text-muted">Saving…</div>}

      <Card>
        <CardTitle>Task Panel <InfoTip text="The /tasks page. Sources are auto-detected; configure only to override." /></CardTitle>
        <div className="divide-y divide-border">
          <Toggle label="Enable task panel" hint="Show the Tasks page in navigation" checked={tasks.enabled !== false} onChange={v => setTasks({ enabled: v })} />
          <Toggle label="Include task journal" hint="Read an external task-journal repo (read-only)" checked={journal.enabled !== false} onChange={v => setJournal({ enabled: v })} />
          <Toggle label="Auto-detect journal path" hint="Use the first configured root that exists" checked={journal.autoDetect !== false} onChange={v => setJournal({ autoDetect: v })} />
        </div>
      </Card>

      <Card>
        <CardTitle>Journal Roots <InfoTip text="One path per line. Used when auto-detect is off, or as extra candidates." /></CardTitle>
        <textarea
          className="w-full h-24 bg-bg-elevated border border-border rounded-md px-3 py-2 text-body-s font-mono text-text outline-none focus-ring transition-colors resize-y"
          value={rootsText}
          onChange={e => setRootsText(e.target.value)}
          onBlur={saveRoots}
          placeholder="~/repos/my-task-journal"
        />
        <div className="text-meta text-muted mt-2">
          Stored in <span className="font-mono">~/.pi/dashboard.json</span> · local ad-hoc tasks: <span className="font-mono">~/.pi/tasks/tasks.json</span>
        </div>
      </Card>

      <Card>
        <CardTitle>Default View</CardTitle>
        <SelectRow
          label="Open with"
          hint="Used only on first visit; your last choice is remembered afterward"
          value={tasks.defaultView ?? 'execute'}
          options={[{ value: 'execute', label: '执行 / Execute' }, { value: 'survey', label: '鸟瞰 / Survey' }]}
          onChange={v => setTasks({ defaultView: v as 'execute' | 'survey' })}
        />
      </Card>

      <Card>
        <CardTitle>External Sources <InfoTip text="Config-declared read-only sources (e.g. Jira/Lark). Add one without code change: a command printing JSON to stdout, or a JSON file." /></CardTitle>
        <textarea
          className="w-full h-40 bg-bg-elevated border border-border rounded-md px-3 py-2 text-meta font-mono text-text outline-none focus-ring transition-colors resize-y"
          value={providersText}
          onChange={e => setProvidersText(e.target.value)}
          spellCheck={false}
        />
        {provErr && <div className="text-2xs text-danger mt-1">{provErr}</div>}
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={saveProviders}
            className="px-3 py-1.5 rounded-md text-body-s font-medium border border-accent text-accent bg-transparent cursor-pointer hover:bg-accent hover:text-accent-fg transition"
          >保存外部来源</button>
          <span className="text-2xs text-muted">
            <span className="font-mono">{`[{ "kind":"file", "id":"jira", "label":"Jira", "file":"~/jira.json" }]`}</span>
          </span>
        </div>
      </Card>
    </div>
  )
}

function DeveloperTab() {
  const [logLevel, setLogLevel] = useState('info')
  const [rawJson, setRawJson] = useState('')
  const [jsonDirty, setJsonDirty] = useState(false)
  const [jsonFeedback, setJsonFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null)
  const status = useAppSelector(s => s.dashboard.status)

  useEffect(() => {
    api.logLevel().then(d => setLogLevel(d.level || 'info')).catch(() => {})
    fetch('/api/pi/settings').then(r => r.json()).then(obj => { setRawJson(JSON.stringify(obj, null, 2)); setJsonDirty(false) }).catch(() => {})
  }, [])

  const changeLevel = useCallback(async (level: string) => {
    setLogLevel(level)
    await api.setLogLevel(level).catch(() => {})
  }, [])

  const saveRawJson = useCallback(async () => {
    try {
      JSON.parse(rawJson) // validate
      const result = await putJson('/api/pi/settings', rawJson)
      if (!result.ok) {
        setJsonFeedback({ type: 'err', msg: result.hint ? `未保存：${result.error} —— ${result.hint}` : `未保存：${result.error}` })
        return
      }
      setJsonDirty(false)
      setJsonFeedback({ type: 'ok', msg: 'Saved' })
    } catch (e: any) {
      setJsonFeedback({ type: 'err', msg: e.message || 'Invalid JSON' })
    }
    setTimeout(() => setJsonFeedback(null), 3000)
  }, [rawJson])

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Diagnostics</CardTitle>
        <div className="divide-y divide-border">
          <SelectRow label="Log level" hint="Controls verbosity of log output" value={logLevel} options={[
            { value: 'debug', label: 'Debug' }, { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warn' }, { value: 'error', label: 'Error' },
          ]} onChange={changeLevel} />
          <div className="flex items-center justify-between py-2">
            <span className="text-body-s text-text">Version</span>
            <span className="text-body-s font-mono text-muted">{status?.version || '—'}</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-body-s text-text">Platform</span>
            <span className="text-body-s font-mono text-muted">{status?.platform || '—'}</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-body-s text-text">Uptime</span>
            <span className="text-body-s font-mono text-muted">{status?.uptime || '—'}</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Actions</CardTitle>
        <div className="flex gap-2 flex-wrap">
          <button className="px-3 py-1.5 rounded-md border border-border bg-transparent text-muted text-body-s cursor-pointer font-body hover:text-text hover:border-border-strong hover:bg-bg-hover transition" onClick={() => api.restartSessions()}>
            🔄 Restart Sessions
          </button>
        </div>
      </Card>

      <Card>
        <CardTitle>
          Raw settings.json
          <InfoTip text="Direct edit of ~/.pi/agent/settings.json — for advanced users" />
          {jsonDirty && <span className="text-2xs text-warn ml-2">● unsaved</span>}
        </CardTitle>
        <Feedback feedback={jsonFeedback} />
        <textarea
          className="w-full bg-bg-elevated border border-border rounded-md p-3 text-body-s font-mono text-text resize-none outline-none focus-ring leading-relaxed min-h-[300px] mt-2"
          value={rawJson}
          onChange={e => { setRawJson(e.target.value); setJsonDirty(true) }}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && jsonDirty) { e.preventDefault(); saveRawJson() } }}
          spellCheck={false}
        />
        <div className="flex justify-end mt-2">
          <button
            className="px-3 py-1.5 rounded-md text-body-s font-medium border border-accent text-accent bg-transparent cursor-pointer hover:bg-accent hover:text-accent-fg transition disabled:opacity-30"
            disabled={!jsonDirty}
            onClick={saveRawJson}
          >
            💾 Save JSON
          </button>
        </div>
      </Card>
    </div>
  )
}

/* ── SHORTCUTS TAB ── */
function ShortcutsTab() {
  const [, setTick] = useState(0)
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => subscribeShortcuts(() => setTick(t => t + 1)), [])

  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const keys = eventToKeyString(e)
      if (!keys) return
      if (keys === 'Escape') { setRecording(null); return }
      setShortcut(recording, keys)
      setRecording(null)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [recording])

  const categories: { id: ActionCategory; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'navigation', label: 'Navigation' },
    { id: 'editing', label: 'Editing' },
  ]

  return (
    <div className="space-y-4">
      {hasCustomShortcuts() && (
        <div className="flex justify-end">
          <button
            className="px-3 py-1.5 rounded-md text-meta font-medium border border-danger text-danger bg-transparent cursor-pointer hover:bg-danger-subtle transition"
            onClick={() => { if (confirm('Reset all shortcuts to defaults?')) resetAllShortcuts() }}
          >
            Reset All to Defaults
          </button>
        </div>
      )}

      {categories.map(cat => {
        const actions = Object.values(ACTIONS).filter(a => a.category === cat.id)
        if (!actions.length) return null
        return (
          <Card key={cat.id}>
            <CardTitle>{cat.label}</CardTitle>
            <div className="divide-y divide-border">
              {actions.map(a => {
                const isRecording = recording === a.id
                const isCustom = a.keys !== a.defaultKeys
                return (
                  <div key={a.id} className="flex items-center justify-between py-2.5 gap-3">
                    <div className="min-w-0">
                      <span className="text-body-s text-text">{a.description}</span>
                      {isCustom && a.defaultKeys && (
                        <div className="text-2xs text-muted opacity-50 mt-0.5">default: <span className="font-mono">{formatKey(a.defaultKeys)}</span></div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        className={`min-w-[80px] px-2.5 py-1.5 rounded-md text-meta font-mono text-center border cursor-pointer transition ${
                          isRecording
                            ? 'border-accent bg-accent-subtle text-accent animate-pulse'
                            : 'border-border bg-bg-elevated text-muted hover:border-border-strong hover:text-text'
                        }`}
                        onClick={() => setRecording(isRecording ? null : a.id)}
                        title={isRecording ? 'Press a key combo (Esc to cancel)' : 'Click to rebind'}
                      >
                        {isRecording ? 'Press keys…' : a.keys ? formatKey(a.keys) : '—'}
                      </button>
                      {isCustom && (
                        <button
                          className="px-1.5 py-1.5 rounded text-2xs text-muted hover:text-text bg-transparent border-none cursor-pointer transition-colors"
                          onClick={() => resetShortcut(a.id)}
                          title="Reset to default"
                        >↺</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        )
      })}

      <div className="text-meta text-muted opacity-50 text-center pt-2">
        Click a binding to record a new key combo · Press Esc to cancel · Customizations are stored in your browser
      </div>
    </div>
  )
}

/* ── SETTINGS PAGE ── */
interface SettingsTabMeta { id: Tab; label: [string, string]; icon: LineIconName; hint: [string, string] }
const SETTINGS_GROUPS: { group: [string, string]; tabs: SettingsTabMeta[] }[] = [
  {
    group: ['Agent', 'Agent'],
    tabs: [
      { id: 'models', label: ['模型列表', 'Model List'], icon: 'list', hint: ['选择服务商和可用模型', 'Choose providers and available models'] },
      { id: 'subagent-models', label: ['子任务模型', 'Subagent Models'], icon: 'flow', hint: ['子 Agent 按档位自动挑模型', 'Subagents pick models automatically by tier'] },
      { id: 'model', label: ['默认模型', 'Model'], icon: 'cpu', hint: ['新会话默认的模型与思考强度', 'Default model & thinking level'] },
      { id: 'behavior', label: ['行为', 'Behavior'], icon: 'sliders', hint: ['权限、工具、运行方式', 'Permissions, tools, runtime'] },
      { id: 'skills', label: ['技能', 'Skills'], icon: 'tool', hint: ['启用和管理技能', 'Enable & manage skills'] },
    ],
  },
  {
    group: ['界面', 'Interface'],
    tabs: [
      { id: 'display', label: ['外观', 'Display'], icon: 'palette', hint: ['主题与外观', 'Theme & appearance'] },
      { id: 'chat', label: ['对话', 'Chat'], icon: 'chat', hint: ['输入框与对话记录', 'Composer & transcript'] },
      { id: 'voice', label: ['语音', 'Voice'], icon: 'volume', hint: ['语音输出模型与音色', 'Voice output model & voice'] },
      { id: 'terminal', label: ['终端', 'Terminal'], icon: 'terminal', hint: ['内置终端', 'Integrated terminal'] },
      { id: 'shortcuts', label: ['快捷键', 'Shortcuts'], icon: 'keyboard', hint: ['按键绑定', 'Keybindings'] },
    ],
  },
  {
    group: ['资源与集成', 'Resources & Integrations'],
    tabs: [
      { id: 'general', label: ['扩展包', 'Packages'], icon: 'box', hint: ['上下文文件与资源', 'Context files & resources'] },
      { id: 'vault', label: ['知识库', 'Vault'], icon: 'book', hint: ['知识库路径', 'Knowledge vault paths'] },
      { id: 'tasks', label: ['任务', 'Tasks'], icon: 'checkCircle', hint: ['任务面板的来源与默认值', 'Task panel sources & defaults'] },
      { id: 'lark', label: ['飞书', 'Lark'], icon: 'send', hint: ['飞书 / Lark 机器人账号', 'Feishu / Lark bot accounts'] },
      { id: 'developer', label: ['开发者', 'Developer'], icon: 'code', hint: ['高级与调试', 'Advanced & debug'] },
    ],
  },
]

/** 中 / EN 分段开关：调用 setLocale，选中项白底 + accent 字。 */
function LanguageSwitch() {
  const { locale } = useLocale()
  return (
    <div role="radiogroup" aria-label="界面语言 / Language" title="界面语言 / Language" className="inline-flex rounded-lg bg-bg-hover p-0.5">
      {([['zh', '中'], ['en', 'EN']] as const).map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={locale === id}
          className={`cursor-pointer rounded-md border-none px-2.5 py-0.5 text-meta transition-colors ${locale === id ? 'bg-card font-medium text-accent shadow-sm' : 'bg-transparent text-muted hover:text-text'}`}
          onClick={() => setLocale(id)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

const SETTINGS_LS_KEY = 'mc-settings-tab'

export default function SettingsPage() {
  const { tr } = useLocale()
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(SETTINGS_LS_KEY) as Tab) || 'models')
  const selectTab = (id: Tab) => { setTab(id); localStorage.setItem(SETTINGS_LS_KEY, id) }
  const activeGroup = SETTINGS_GROUPS.find(g => g.tabs.some(t => t.id === tab))
  const activeMeta = activeGroup?.tabs.find(t => t.id === tab)
  // 原 PageHeader 在原生 App（iOS/Android 壳）里提供“返回 Chat”按钮，改版后保留该入口。
  const isNativeApp = typeof navigator !== 'undefined' && (navigator.userAgent.includes('PiDash-iOS') || navigator.userAgent.includes('PiDash-Android'))

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Vertical grouped nav */}
      <nav className="hidden w-[220px] shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-accent px-2.5 py-3.5 md:flex">
        <div className="mx-1.5 mb-2.5 flex items-center">
          <h1 className="m-0 flex-1 text-title font-semibold text-text-strong">{tr('设置', 'Settings')}</h1>
          <LanguageSwitch />
        </div>
        {SETTINGS_GROUPS.map(({ group, tabs }) => (
          <div key={group[1]}>
            <div className="mx-2 mb-1 mt-3 text-2xs font-semibold text-muted">{tr(group[0], group[1])}</div>
            {tabs.map(t => (
              <button
                key={t.id}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-body-s transition ${tab === t.id ? 'border-border bg-card font-medium text-accent shadow-sm' : 'border-transparent bg-transparent text-muted hover:bg-bg-hover hover:text-text'}`}
                onClick={() => selectTab(t.id)}
                title={tr(t.hint[0], t.hint[1])}
              >
                <LineIcon name={t.icon} className="h-4 w-4" />
                <span className="truncate">{tr(t.label[0], t.label[1])}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile horizontal nav */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-3 md:hidden">
          <LanguageSwitch />
          {SETTINGS_GROUPS.flatMap(g => g.tabs).map(t => (
            <button
              key={t.id}
              className={`flex cursor-pointer items-center gap-1 rounded-md border px-3 py-1.5 text-body-s font-medium transition ${tab === t.id ? 'border-border bg-card text-accent' : 'border-transparent bg-transparent text-muted hover:bg-bg-hover hover:text-text'}`}
              onClick={() => selectTab(t.id)}
            >
              <LineIcon name={t.icon} className="h-4 w-4" />
              {tr(t.label[0], t.label[1])}
            </button>
          ))}
        </div>

        {/* Content pane */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-8 md:py-6">
          <div className="mx-auto max-w-3xl">
            {isNativeApp && (
              <button
                type="button"
                className="mb-3 flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-body-s font-medium text-accent hover:opacity-70"
                onClick={() => window.history.back()}
              >
                <LineIcon name="chevronRight" className="h-4 w-4 rotate-180" />
                Chat
              </button>
            )}
            {activeMeta && activeGroup && (
              <div className="mb-5 hidden md:block">
                <div className="text-2xs text-muted">{tr(activeGroup.group[0], activeGroup.group[1])} / {tr(activeMeta.label[0], activeMeta.label[1])}</div>
                <h2 className="mb-0.5 mt-0.5 text-title font-semibold text-text-strong font-body">{tr(activeMeta.label[0], activeMeta.label[1])}</h2>
                <p className="m-0 text-body-s text-muted">{tr(activeMeta.hint[0], activeMeta.hint[1])}</p>
              </div>
            )}
            <div>
              {tab === 'models' && <ModelListTab />}
              {tab === 'subagent-models' && <SubagentModelsTab />}
              {tab === 'model' && <ModelTab />}
              {tab === 'behavior' && <BehaviorTab />}
              {tab === 'terminal' && <TerminalTab />}
              {tab === 'general' && <GeneralTab />}
              {tab === 'skills' && <SkillsTab />}
              {tab === 'chat' && <ChatTab />}
              {tab === 'voice' && <VoiceTab />}
              {tab === 'display' && <DisplayTab />}
              {tab === 'shortcuts' && <ShortcutsTab />}
              {tab === 'vault' && <VaultTab />}
              {tab === 'tasks' && <TasksTab />}
              {tab === 'lark' && <LarkTab />}
              {tab === 'developer' && <DeveloperTab />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
