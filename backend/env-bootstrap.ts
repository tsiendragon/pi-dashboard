/**
 * Side-effect module: load the dashboard env files before anything else runs.
 *
 * It must stay the FIRST import of an entry module (server.ts), because modules that snapshot
 * `process.env` while they are being imported would otherwise miss these values — pi-manager
 * resolves `PI_SCRIPT` that way (it now resolves lazily as well, belt and braces).
 */
import { loadDashboardEnv } from './env-file.js'

const { files, error } = loadDashboardEnv()

if (files.length > 0) {
  const summary = files.map((f) => `${f.path} (+${f.applied.length})`).join(', ')
  console.log(`[env] loaded env file(s): ${summary}`)
}
if (error) console.error(`[env] ${error}`)