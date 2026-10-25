import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../../store'
import { uiAnswered } from '../../store/liveSessionsSlice'
import type { LiveSessionSummary, LiveSessionUiRequest } from '@shared/live-sessions'
import { liveSessionApi } from './api'
import { hasConfirmationMarker } from '../supervisor/pendingConfirmation'

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
      // Requests that name their target object are carried by the task page and the sidebar badge.
      // Only the ones with nowhere to live stay in this modal, which is now a small fallback card.
      Object.values(bucket ?? {}).filter(request => !hasConfirmationMarker(request)).map(request => ({ sessionId, request })),
    )
  }, [pendingUi, processInstanceId])
  if (scoped.length === 0) return null
  return (
    // A corner stack, not a screen-covering modal: these are requests with no page of their own, and
    // the task page / sidebar badge already carry everything that names a target object.
    <div className="fixed bottom-4 right-4 z-50 flex w-[min(92vw,24rem)] flex-col gap-2">
      {scoped.map(({ sessionId, request }) => (
        <UiDialog
          key={`${sessionId}:${request.id}`}
          processInstanceId={sessionId}
          request={request}
          sessionLabel={processInstanceId ? undefined : sessionLabelOf(sessions[sessionId])}
        />
      ))}
    </div>
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
      {/* No dim layer any more: a click outside used to be read as "No" (a blocking confirmation
          vanished within seconds while the user never chose anything), and a full-screen scrim also
          hid the page behind it. The card is small, stays in the corner, and never blocks the app. */}
      <div
        role="dialog"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[min(70dvh,32rem)] w-full flex-col overflow-hidden rounded-xl border border-accent/60 bg-bg-elevated p-4 shadow-2xl"
      >
        <div className="mb-1 shrink-0 text-body-s font-medium text-warn">需要你回答，否则这项操作不会执行</div>
        <div className="mb-3 shrink-0 text-sm font-semibold text-text-strong">{request.title || 'Extension request'}</div>
        {sessionLabel && <div className="mb-2 shrink-0 text-2xs text-muted">来自会话：{sessionLabel}</div>}
        {request.message && (
          <div className="mb-3 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-body-s text-muted">{request.message}</div>
        )}

        {request.method === 'confirm' && (
          <div className="flex shrink-0 justify-end gap-2">
            <button
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40"
              onClick={cancel}
              disabled={submitting}
            >不允许</button>
            <button
              className="rounded-lg border-none bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40"
              onClick={() => respond({ value: 'true' })}
              disabled={submitting}
            >允许这次操作</button>
          </div>
        )}

        {request.method === 'select' && (
          <div className="flex shrink-0 flex-col gap-1.5">
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
            <div className="flex shrink-0 justify-end gap-2">
              <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40" onClick={cancel} disabled={submitting}>Cancel</button>
              <button type="submit" className="rounded-lg border-none bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40" disabled={submitting}>Submit</button>
            </div>
          </form>
        )}

        {request.method === 'editor' && (
          <form onSubmit={(event) => { event.preventDefault(); respond({ value }) }}>
            <textarea
              ref={firstFieldRef as React.RefObject<HTMLTextAreaElement>}
              className="mb-3 h-40 max-h-[45dvh] w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-body-s text-text outline-none focus:border-accent"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="flex shrink-0 justify-end gap-2">
              <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-bg disabled:opacity-40" onClick={cancel} disabled={submitting}>Cancel</button>
              <button type="submit" className="rounded-lg border-none bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40" disabled={submitting}>Save</button>
            </div>
          </form>
        )}
      </div>
    </>
  )
}
