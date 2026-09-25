import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../../store'
import { uiAnswered } from '../../store/liveSessionsSlice'
import type { LiveSessionSummary, LiveSessionUiRequest } from '@shared/live-sessions'
import { liveSessionApi } from './api'

/**
 * Live-session counterpart of the RPC ExtensionUiModal. Renders extension UI
 * requests (confirm / select / input / editor) that the live-session bridge
 * extension projects from `pi.on("extension_ui")`, and answers them through the
 * `answer_ui` live-session command → `pi.respondExtensionUi`. First answer wins
 * (no lease): any open web client, or the TUI itself, settles the request; the
 * L1 `extension_ui_closed` event removes it here once answered elsewhere.
 */
export default function LiveSessionExtensionUiModal({ processInstanceId }: { processInstanceId?: string } = {}) {
  const pendingUi = useAppSelector(state => state.liveSessions.pendingUi)
  const sessions = useAppSelector(state => state.liveSessions.sessions)
  const scoped = useMemo(() => {
    const buckets = processInstanceId ? [[processInstanceId, pendingUi[processInstanceId]] as const] : Object.entries(pendingUi)
    return buckets.flatMap(([sessionId, bucket]) =>
      Object.values(bucket ?? {}).map(request => ({ sessionId, request })),
    )
  }, [pendingUi, processInstanceId])
  if (scoped.length === 0) return null
  return (
    <>
      {scoped.map(({ sessionId, request }) => (
        <UiDialog
          key={`${sessionId}:${request.id}`}
          processInstanceId={sessionId}
          request={request}
          sessionLabel={processInstanceId ? undefined : sessionLabelOf(sessions[sessionId])}
        />
      ))}
    </>
  )
}

function sessionLabelOf(summary: LiveSessionSummary | undefined): string | undefined {
  if (!summary) return undefined
  return summary.sessionName || `Pi ${summary.pid}`
}

function UiDialog({ processInstanceId, request, sessionLabel }: { processInstanceId: string; request: LiveSessionUiRequest; sessionLabel?: string }) {
  const dispatch = useAppDispatch()
  const [value, setValue] = useState(request.prefill ?? '')
  const [submitting, setSubmitting] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setValue(request.prefill ?? '')
    setSubmitting(false)
    const timer = setTimeout(() => firstFieldRef.current?.focus(), 30)
    return () => clearTimeout(timer)
  }, [request.id])

  const respond = async (body: { cancelled?: boolean; value?: string }) => {
    if (submitting) return
    setSubmitting(true)
    // Optimistically drop the dialog; the extension's first-answer settle also
    // emits extension_ui_closed which is idempotent here.
    dispatch(uiAnswered({ processInstanceId, id: request.id }))
    try {
      await liveSessionApi.command(processInstanceId, { type: 'answer_ui', id: request.id, ...body })
    } catch {
      /* already answered / timed out upstream — ignore */
    }
  }

  const cancel = () => respond({ cancelled: true })
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={cancel} />
      <div
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
        className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-elevated p-5 shadow-2xl"
      >
        <div className="mb-3 text-sm font-semibold text-text-strong">{request.title || 'Extension request'}</div>
        {sessionLabel && <div className="mb-2 text-2xs text-muted">来自会话：{sessionLabel}</div>}
        {request.message && (
          <div className="mb-3 whitespace-pre-wrap text-body-s text-muted">{request.message}</div>
        )}

        {request.method === 'confirm' && (
          <div className="flex justify-end gap-2">
            <button
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40"
              onClick={cancel}
              disabled={submitting}
            >No</button>
            <button
              className="rounded-lg border-none bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40"
              onClick={() => respond({ value: 'true' })}
              disabled={submitting}
            >Yes</button>
          </div>
        )}

        {request.method === 'select' && (
          <div className="flex flex-col gap-1.5">
            {(request.options || []).map((option, index) => (
              <button
                key={index}
                className="rounded-lg border border-border px-3 py-2 text-left text-sm text-text hover:bg-accent-subtle hover:border-accent disabled:opacity-40"
                onClick={() => respond({ value: option })}
                disabled={submitting}
              >{option}</button>
            ))}
            <button
              className="mt-1 self-end rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40"
              onClick={cancel}
              disabled={submitting}
            >Cancel</button>
          </div>
        )}

        {request.method === 'input' && (
          <form onSubmit={(event) => { event.preventDefault(); respond({ value }) }}>
            <input
              ref={firstFieldRef as React.RefObject<HTMLInputElement>}
              className="mb-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40" onClick={cancel} disabled={submitting}>Cancel</button>
              <button type="submit" className="rounded-lg border-none bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40" disabled={submitting}>Submit</button>
            </div>
          </form>
        )}

        {request.method === 'editor' && (
          <form onSubmit={(event) => { event.preventDefault(); respond({ value }) }}>
            <textarea
              ref={firstFieldRef as React.RefObject<HTMLTextAreaElement>}
              className="mb-3 h-40 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-body-s text-text outline-none focus:border-accent"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40" onClick={cancel} disabled={submitting}>Cancel</button>
              <button type="submit" className="rounded-lg border-none bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40" disabled={submitting}>Save</button>
            </div>
          </form>
        )}
      </div>
    </>
  )
}
