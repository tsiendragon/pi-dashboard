import { useCallback, useEffect, useRef } from 'react'
import type { LiveSessionBrowserEvent, LiveSessionDetail, LiveSessionEventMessage, LiveSessionSummary } from '@shared/live-sessions'
import { useAppDispatch, useAppSelector } from '../../store'
import {
  authRequired,
  authenticated,
  liveSessionAttached,
  liveSessionClaimChanged,
  liveSessionDetached,
  liveSessionEvent,
  liveSessionReconnecting,
  liveSessionSnapshot,
  sessionsLoaded,
  setLiveSessionError,
  setLiveWebSocketConnected,
} from '../../store/liveSessionsSlice'
import { liveSessionApi, LiveSessionApiError } from './api'
import { cancelDetach, DETACH_FLUSH_MS, expireDetaches, pendingSummaries, scheduleDetach, type PendingDetach } from './detachGrace'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useLiveSessionsRuntime(): { refresh: () => Promise<void> } {
  const dispatch = useAppDispatch()
  const auth = useAppSelector(state => state.liveSessions.auth)
  const details = useAppSelector(state => state.liveSessions.details)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const stopped = useRef(false)
  // Detached sessions keep their row for a grace window instead of blinking out
  // and back while their Pi reconnects (see detachGrace.ts).
  const pendingDetach = useRef(new Map<string, PendingDetach>())

  const refresh = useCallback(async () => {
    try {
      const result = await liveSessionApi.list()
      // Sessions detached inside their grace window are absent from this payload;
      // re-adding them keeps their rows from disappearing for a moment.
      const kept = pendingSummaries(pendingDetach.current, Date.now(), result.sessions.map(summary => summary.processInstanceId))
      dispatch(sessionsLoaded(kept.length > 0 ? { ...result, sessions: [...result.sessions, ...kept] } : result))
      dispatch(authenticated({ browserClientId: result.browserClientId }))
    } catch (error) {
      if (error instanceof LiveSessionApiError && error.status === 401) dispatch(authRequired())
      else dispatch(setLiveSessionError(messageOf(error)))
    }
  }, [dispatch])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (auth !== 'authenticated') return
    stopped.current = false
    let socket: WebSocket | undefined
    let retry = 0

    const applyFrame = (frame: LiveSessionBrowserEvent): void => {
      switch (frame.type) {
        case 'live_session_attached': {
          const attached = frame.data as LiveSessionDetail | { sessions: LiveSessionSummary[] }
          if ('sessions' in attached) for (const summary of attached.sessions) cancelDetach(pendingDetach.current, summary.processInstanceId)
          else cancelDetach(pendingDetach.current, attached.summary.processInstanceId)
          dispatch(liveSessionAttached(attached))
          break
        }
        case 'live_session_snapshot':
          // A snapshot means the session is talking to us again.
          cancelDetach(pendingDetach.current, (frame.data as LiveSessionDetail).summary.processInstanceId)
          dispatch(liveSessionSnapshot(frame.data as LiveSessionDetail))
          break
        case 'live_session_event':
          dispatch(liveSessionEvent(frame.data as LiveSessionEventMessage))
          break
        case 'live_session_claim_changed':
          dispatch(liveSessionClaimChanged(frame.data as LiveSessionSummary))
          break
        case 'live_session_reconnecting':
          dispatch(liveSessionReconnecting(frame.data as LiveSessionSummary))
          break
        case 'live_session_detached': {
          // Keep the row briefly: the registry dropped the entry, but a Pi that
          // reconnects will announce itself again and the row would blink.
          const detached = frame.data as { summary: LiveSessionSummary; reason?: string }
          scheduleDetach(pendingDetach.current, detached.summary, Date.now(), detached.reason)
          void refresh()
          break
        }
        case 'live_session_error':
          dispatch(setLiveSessionError(messageOf(frame.data)))
          break
      }
    }

    const scheduleReconnect = (): void => {
      if (stopped.current || reconnectTimer.current) return
      const delay = Math.min(10_000, 500 * 2 ** Math.min(retry++, 5))
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = undefined
        void connect()
      }, delay)
    }

    const connect = async (): Promise<void> => {
      if (stopped.current || socket) return
      let ticket: string
      try {
        ticket = (await liveSessionApi.websocketTicket()).ticket
      } catch (error) {
        if (stopped.current) return
        if (error instanceof LiveSessionApiError && error.status === 401) {
          dispatch(authRequired('Live Session 认证已失效'))
          return
        }
        dispatch(setLiveSessionError(messageOf(error)))
        scheduleReconnect()
        return
      }
      if (stopped.current) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/api/live-sessions/ws?ticket=${encodeURIComponent(ticket)}`)
      socket.onopen = () => {
        retry = 0
        dispatch(setLiveWebSocketConnected(true))
      }
      socket.onmessage = event => {
        try { applyFrame(JSON.parse(String(event.data)) as LiveSessionBrowserEvent) }
        catch { dispatch(setLiveSessionError('Live Session WebSocket 返回了无效数据')) }
      }
      socket.onerror = () => {}
      socket.onclose = event => {
        socket = undefined
        dispatch(setLiveWebSocketConnected(false))
        if (event.code === 1008 || event.code === 4401) {
          dispatch(authRequired('Live Session 认证已失效'))
          return
        }
        if (stopped.current) return
        scheduleReconnect()
      }
    }

    void connect()
    return () => {
      stopped.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      reconnectTimer.current = undefined
      socket?.close()
      dispatch(setLiveWebSocketConnected(false))
    }
  }, [auth, dispatch, refresh])

  useEffect(() => {
    if (auth !== 'authenticated') return
    for (const [processInstanceId, detail] of Object.entries(details)) {
      if (!detail.needsResync) continue
      liveSessionApi.detail(processInstanceId).then(snapshot => {
        // Applying the snapshot clears `needsResync` (the reducer drops the flag
        // when it replaces the detail). If the payload turns out to be a no-op
        // the flag deliberately stays set so the next change retries — never
        // report a resync that did not actually land.
        dispatch(liveSessionSnapshot(snapshot))
      }).catch(error => dispatch(setLiveSessionError(messageOf(error))))
    }
  }, [auth, details, dispatch])

  // Flush rows whose grace window has closed. Nothing is dispatched while no
  // session is pending, so the tick is free in the common case.
  useEffect(() => {
    if (auth !== 'authenticated') return
    const timer = setInterval(() => {
      for (const entry of expireDetaches(pendingDetach.current, Date.now())) {
        dispatch(liveSessionDetached({ summary: entry.summary, ...(entry.reason ? { reason: entry.reason } : {}) }))
      }
    }, DETACH_FLUSH_MS)
    return () => clearInterval(timer)
  }, [auth, dispatch])

  return { refresh }
}
