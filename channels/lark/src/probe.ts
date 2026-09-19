/**
 * Connectivity probe: verifies the gateway can reach pi-dashboard live-sessions
 * without needing any Lark credentials.
 *
 *   npx tsx channels/lark/src/probe.ts
 *   npx tsx channels/lark/src/probe.ts <processInstanceId> "hello from probe"
 */
import type { LiveSessionBrowserEvent, LiveSessionSummary } from '../../../shared/src/live-sessions.js'
import { loadConfig } from './config.js'
import { DashboardClient } from './dashboardClient.js'

function label(summary: LiveSessionSummary): string {
  return summary.sessionName || summary.sessionFile || summary.processInstanceId
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const client = new DashboardClient(cfg)
  const [targetId, targetText] = process.argv.slice(2)

  const sessions = await client.listSessions()
  console.log(`[probe] connected to ${cfg.dashboardBaseUrl}`)
  console.log(`[probe] ${sessions.length} live session(s):`)
  for (const s of sessions) console.log(`  - ${label(s)}  (${s.processInstanceId})  ${s.status}  cwd=${s.cwd}`)

  await client.subscribe((frame: LiveSessionBrowserEvent) => {
    switch (frame.type) {
      case 'live_session_attached': {
        const data = frame.data as { sessions?: LiveSessionSummary[] }
        console.log(`[frame] attached (${data.sessions?.length ?? 0} sessions)`)
        break
      }
      case 'live_session_snapshot': {
        const data = frame.data as { summary?: LiveSessionSummary }
        if (data.summary) console.log(`[frame] snapshot ${label(data.summary)}`)
        break
      }
      case 'live_session_event': {
        const data = frame.data as { processInstanceId?: string; event?: { type?: string } }
        console.log(`[frame] event ${data.event?.type ?? '?'} @ ${data.processInstanceId ?? '?'}`)
        break
      }
      default:
        console.log(`[frame] ${frame.type}`)
    }
  })

  if (targetId && targetText) {
    await client.sendInput(targetId, targetText)
    console.log(`[probe] sent input to ${targetId}`)
  }

  console.log('[probe] streaming; Ctrl-C to stop')
}

main().catch(error => {
  console.error('[probe] failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
