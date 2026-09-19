import os from 'node:os'
import path from 'node:path'

export interface LarkGatewayConfig {
  /** dashboard base url, no trailing slash */
  dashboardBaseUrl: string
  /** path to the live-session control token */
  controlTokenPath: string
  /** where chat <-> session bindings are persisted */
  mappingPath: string
  /** dashboard-managed Lark accounts file (shared with backend/routes/lark.ts) */
  accountsPath: string
  /** Lark (Feishu) self-built app credentials (optional until the Lark side runs) */
  larkAppId?: string
  larkAppSecret?: string
  /** Open-platform domain: 'feishu' (default) or 'lark' (international). */
  larkDomain?: 'feishu' | 'lark'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LarkGatewayConfig {
  const port = env.PI_DASH_PORT || '7777'
  const base = (env.PI_LIVE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '')
  return {
    dashboardBaseUrl: base,
    controlTokenPath:
      env.PI_LIVE_CONTROL_TOKEN_PATH ||
      path.join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard', 'live-control-token'),
    mappingPath:
      env.PI_LARK_MAPPING ||
      path.join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard', 'lark-mapping.json'),
    accountsPath:
      env.PI_LARK_ACCOUNTS ||
      path.join(os.homedir(), '.pi', 'agent', 'run', 'pi-dashboard', 'lark-accounts.json'),
    larkAppId: env.LARK_APP_ID || undefined,
    larkAppSecret: env.LARK_APP_SECRET || undefined,
  }
}
