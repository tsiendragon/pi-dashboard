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
  liveSessionResynced,
  liveSessionSnapshot,
  sessionsLoaded,
  setLiveSessionError,
  setLiveWebSocketConnected,
} from '../../store/liveSessionsSlice'
import { liveSessionApi, LiveSessionApiError } from './api'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useLiveSessionsRuntime(): { refresh: () => Promise<void> } {
  const dispatch = useAppDispatch()
  const auth = useAppSelector(state => state.liveSessions.auth)
  const details = useAppSelector(state => state.liveSessions.details)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const stopped = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const result = await liveSessionApi.list()
      dispatch(sessionsLoaded(result))
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
        case 'live_session_attached':
          dispatch(liveSessionAttached(frame.data as LiveSessionDetail | { sessions: LiveSessionSummary[] }))
          break
        case 'live_session_snapshot':
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
        case 'live_session_detached':
          dispatch(liveSessionDetached(frame.data as { summary: LiveSessionSummary; reason?: string }))
          void refresh()
          break
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
        dispatch(liveSessionSnapshot(snapshot))
        dispatch(liveSessionResynced(processInstanceId))
      }).catch(error => dispatch(setLiveSessionError(messageOf(error))))
    }
  }, [auth, details, dispatch])

  return { refresh }
}
