// @ts-nocheck — Plugin files are bundled by Vite, not type-checked by the frontend tsc config.
/**
 * Pi extension config settings (dashboard plugin).
 *
 * Claims the `settings-section` slot on the Settings page and renders one card per whitelisted
 * extension config file. All filesystem access goes through the backend (`/api/ext/config`), which
 * validates the name against its own whitelist and writes atomically.
 *
 * Editing semantics: extensions read their config file when they load, so a change only takes effect
 * after `/reload` **or** a new session — that is called out in the UI instead of pretending otherwise.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

type FieldType = 'bool' | 'number' | 'string' | 'json'

interface FieldSpec {
  key: string
  type: FieldType
  label: string
  hint?: string
  options?: string[]
}

interface ConfigEntry {
  name: string
  file: string
  description: string
  fields: FieldSpec[]
  path: string
  exists: boolean
  readable: boolean
  content: Record<string, unknown> | null
  seed: Record<string, unknown> | null
}

interface ListResponse {
  agentDir: string
  configs: ConfigEntry[]
}

function getPath(obj: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part]
    return undefined
  }, obj)
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.')
  const next = { ...obj }
  let cursor: Record<string, unknown> = next
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part]
    cursor[part] = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
  return next
}

const inputClass =
  'w-full rounded border border-border bg-bg px-2 py-1 text-[13px] text-text outline-none focus:border-accent'

function Field({
  spec,
  draft,
  raw,
  onValue,
  onRaw,
}: {
  spec: FieldSpec
  draft: Record<string, unknown>
  raw: string | undefined
  onValue: (key: string, value: unknown) => void
  onRaw: (key: string, value: string) => void
}) {
  const value = getPath(draft, spec.key)
  const id = `extcfg-${spec.key.replace(/\./g, '-')}`

  if (spec.type === 'bool') {
    return (
      <label className="flex items-center gap-2 text-[13px] text-text" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onValue(spec.key, e.target.checked)}
        />
        <span>{spec.label}</span>
        {spec.hint ? <span className="text-[11px] text-muted">{spec.hint}</span> : null}
      </label>
    )
  }

  if (spec.type === 'number') {
    return (
      <div className="space-y-0.5">
        <label className="block text-[12px] text-muted" htmlFor={id}>
          {spec.label}
          {spec.hint ? <span className="ml-1">· {spec.hint}</span> : null}
        </label>
        <input
          id={id}
          type="number"
          className={inputClass}
          value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
          onChange={(e) => onValue(spec.key, e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </div>
    )
  }

  if (spec.type === 'string') {
    return (
      <div className="space-y-0.5">
        <label className="block text-[12px] text-muted" htmlFor={id}>
          {spec.label}
          {spec.hint ? <span className="ml-1">· {spec.hint}</span> : null}
        </label>
        {spec.options?.length ? (
          <select
            id={id}
            className={inputClass}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onValue(spec.key, e.target.value)}
          >
            <option value="">— default —</option>
            {spec.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            className={inputClass}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onValue(spec.key, e.target.value)}
          />
        )}
      </div>
    )
  }

  const text = raw ?? JSON.stringify(value ?? (spec.type === 'json' ? [] : null), null, 2)
  let parseError = false
  try {
    JSON.parse(text)
  } catch {
    parseError = true
  }
  return (
    <div className="space-y-0.5">
      <label className="block text-[12px] text-muted" htmlFor={id}>
        {spec.label}
        {spec.hint ? <span className="ml-1">· {spec.hint}</span> : null}
        {parseError ? <span className="ml-1 text-danger">· JSON 语法错误</span> : null}
      </label>
      <textarea
        id={id}
        rows={3}
        spellCheck={false}
        className={`${inputClass} font-mono`}
        value={text}
        onChange={(e) => onRaw(spec.key, e.target.value)}
      />
    </div>
  )
}

export function ExtensionConfigSettings() {
  const [state, setState] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const [rawFields, setRawFields] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ext/config')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ListResponse
      setState(data)
      setDrafts(
        Object.fromEntries(
          data.configs.map((c) => [c.name, (c.content ?? c.seed ?? {}) as Record<string, unknown>]),
        ),
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const updateField = useCallback((name: string, key: string, value: unknown) => {
    setDrafts((prev) => ({ ...prev, [name]: setPath(prev[name] ?? {}, key, value) }))
  }, [])

  const updateRaw = useCallback((name: string, key: string, value: string) => {
    setRawFields((prev) => ({ ...prev, [`${name}.${key}`]: value }))
  }, [])

  const save = useCallback(
    async (entry: ConfigEntry) => {
      const draft = { ...(drafts[entry.name] ?? {}) }
      for (const spec of entry.fields) {
        if (spec.type !== 'json') continue
        const text = rawFields[`${entry.name}.${spec.key}`]
        if (text === undefined) continue
        try {
          setPath(draft, spec.key, JSON.parse(text))
        } catch {
          setStatus((prev) => ({ ...prev, [entry.name]: `✗ ${spec.label} 不是合法 JSON` }))
          return
        }
      }
      setBusy(entry.name)
      try {
        const res = await fetch(`/api/ext/config/${encodeURIComponent(entry.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setStatus((prev) => ({
          ...prev,
          [entry.name]: res.ok ? '✓ 已保存（/reload 或重开会话生效）' : `✗ ${body.error ?? res.status}`,
        }))
        if (res.ok) await load()
      } catch (e) {
        setStatus((prev) => ({
          ...prev,
          [entry.name]: `✗ ${e instanceof Error ? e.message : String(e)}`,
        }))
      } finally {
        setBusy(null)
      }
    },
    [drafts, rawFields, load],
  )

  const summary = useMemo(() => {
    if (!state) return null
    const existing = state.configs.filter((c) => c.exists).length
    return `${existing}/${state.configs.length} 个配置文件已存在 · ${state.agentDir}`
  }, [state])

  if (error) {
    return (
      <div className="rounded-lg border border-danger bg-card p-3 text-[13px] text-danger">
        Extension config 读取失败：{error}
      </div>
    )
  }
  if (!state) {
    return <div className="text-[13px] text-muted">Extension config 加载中…</div>
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-text-strong">Extension config</h3>
        <p className="text-[11px] text-muted">
          {summary}。缺失的文件用扩展内置默认值；改完需要 <code>/reload</code> 或重开会话才生效。
        </p>
      </div>

      {state.configs.map((entry) => (
        <div key={entry.name} className="rounded-lg border border-border bg-card p-3 space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold text-text-strong">{entry.name}</span>
            <span className="font-mono text-[11px] text-muted">{entry.file}</span>
            <span className={`text-[11px] ${entry.exists ? 'text-muted' : 'text-accent'}`}>
              {entry.exists ? '已存在' : '未创建（用默认值）'}
            </span>
            {entry.exists && !entry.readable ? (
              <span className="text-[11px] text-danger">文件不是合法 JSON</span>
            ) : null}
          </div>
          <p className="text-[11px] text-muted">{entry.description}</p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {entry.fields.map((spec) => (
              <Field
                key={spec.key}
                spec={spec}
                draft={drafts[entry.name] ?? {}}
                raw={rawFields[`${entry.name}.${spec.key}`]}
                onValue={(key, value) => updateField(entry.name, key, value)}
                onRaw={(key, value) => updateRaw(entry.name, key, value)}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy === entry.name}
              onClick={() => void save(entry)}
              className="rounded border border-border bg-bg-hover px-2 py-1 text-[12px] text-text disabled:opacity-50"
            >
              {entry.exists ? '保存' : '创建并保存'}
            </button>
            {status[entry.name] ? (
              <span className="text-[11px] text-muted">{status[entry.name]}</span>
            ) : null}
          </div>

          <details className="text-[11px] text-muted">
            <summary className="cursor-pointer">原始 JSON（当前草稿）</summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-[11px]">
              {JSON.stringify(drafts[entry.name] ?? {}, null, 2)}
            </pre>
            <p className="mt-1 font-mono">{entry.path}</p>
          </details>
        </div>
      ))}

      <p className="text-[11px] text-muted">
        项目级配置（<code>&lt;cwd&gt;/.pi/tsien-memory.json</code>、<code>&lt;cwd&gt;/.pi/rtk-config.json</code>）与
        <code>theme.json</code>（可选覆盖文件）不在这个列表里。
      </p>
    </div>
  )
}