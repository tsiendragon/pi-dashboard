/**
 * Controlled self-restart for Dashboard processes supervised by systemd.
 *
 * The dashboard must not run sudo or accept a command from the client. Under systemd,
 * exiting with SIGTERM is enough because the unit's Restart=always policy starts the
 * updated process again. Manual `./run.sh` processes are deliberately rejected: a web
 * button must never leave an unmanaged dashboard offline.
 */

export interface DashboardRestartControl {
  readonly supported: boolean
  /** Queue one graceful process exit. Returns false when unsupported or already queued. */
  request(): boolean
}

export interface DashboardRestartOptions {
  env?: NodeJS.ProcessEnv
  pid?: number
  delayMs?: number
  schedule?: (callback: () => void, delayMs: number) => { unref?: () => void }
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

export function createDashboardRestartControl(options: DashboardRestartOptions = {}): DashboardRestartControl {
  const env = options.env ?? process.env
  const supported = typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.trim().length > 0
  const pid = options.pid ?? process.pid
  const delayMs = options.delayMs ?? 250
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const kill = options.kill ?? ((target, signal) => process.kill(target, signal))
  let requested = false

  return {
    supported,
    request(): boolean {
      if (!supported || requested) return false
      requested = true
      const timer = schedule(() => {
        try {
          kill(pid, 'SIGTERM')
        } catch (error) {
          console.error('[dashboard] failed to schedule self-restart:', error)
        }
      }, delayMs)
      timer.unref?.()
      return true
    },
  }
}
