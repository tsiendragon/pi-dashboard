/**
 * Cheap host-load sample for the machine list.
 *
 * `/api/system` also reports CPU/load/memory, but it shells out to `df` and `ps`
 * and computes CPU from cumulative since-boot counters (which never shows the
 * current spike). This module deliberately reads only `os` + `/proc/meminfo` and
 * samples CPU across a short window, so the phone can poll it while a list is
 * open without turning a status request into a process audit.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'

export interface MachineLoad {
  cpuCount: number
  /** Percent busy during the sample window; null when no reliable delta exists. */
  cpuPercent: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  memoryTotalBytes: number
  memoryUsedBytes: number
  memoryAvailableBytes: number
  memoryUsedPercent: number | null
  sampledAt: number
}

interface CpuTotals { idle: number; total: number; count: number }

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function cpuTotals(): CpuTotals {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total, count: cpus.length }
}

function memoryTotals(): Pick<MachineLoad, 'memoryTotalBytes' | 'memoryUsedBytes' | 'memoryAvailableBytes' | 'memoryUsedPercent'> {
  let total = os.totalmem()
  let available = os.freemem()
  // Linux `os.freemem()` excludes reclaimable cache, which makes a healthy host
  // look nearly full. MemAvailable is the kernel's own estimate of what a new
  // workload can actually use, so prefer it when the proc file is available.
  if (process.platform === 'linux') {
    try {
      const info = readFileSync('/proc/meminfo', 'utf8')
      const totalKb = Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(info)?.[1])
      const availableKb = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(info)?.[1])
      if (Number.isFinite(totalKb) && totalKb > 0) total = totalKb * 1024
      if (Number.isFinite(availableKb) && availableKb >= 0) available = availableKb * 1024
    } catch {
      // Non-Linux or a restricted container: the os fallback is still useful.
    }
  }
  available = Math.max(0, Math.min(total, available))
  const used = Math.max(0, total - available)
  return {
    memoryTotalBytes: total,
    memoryUsedBytes: used,
    memoryAvailableBytes: available,
    memoryUsedPercent: total > 0 ? round((used / total) * 100) : null,
  }
}

/**
 * Sample CPU over `sampleMs` and combine it with the kernel load average and
 * available memory. Kept short (100 ms by default) so a refresh never waits on a
 * full second.
 */
export async function readMachineLoad(sampleMs = 100): Promise<MachineLoad> {
  const first = cpuTotals()
  if (sampleMs > 0) await new Promise(resolve => setTimeout(resolve, sampleMs))
  const second = cpuTotals()
  const idle = second.idle - first.idle
  const total = second.total - first.total
  const cpuPercent = total > 0
    ? round(Math.max(0, Math.min(100, (1 - idle / total) * 100)))
    : null
  const load = os.loadavg()
  const memory = memoryTotals()
  return {
    cpuCount: second.count,
    cpuPercent,
    load1: Number.isFinite(load[0]) ? round(load[0], 2) : null,
    load5: Number.isFinite(load[1]) ? round(load[1], 2) : null,
    load15: Number.isFinite(load[2]) ? round(load[2], 2) : null,
    ...memory,
    sampledAt: Date.now(),
  }
}
