/**
 * Cheap host-load sample for the machine list.
 *
 * `/api/system` also reports CPU/load/memory, but it shells out to `df` and `ps`
 * and computes CPU from cumulative since-boot counters (which never shows the
 * current spike). This module avoids those shell commands: it reads `os`,
 * `/proc/meminfo`, `statfs`, and Linux DRM sysfs. GPU utilization is optional:
 * AMD/Intel cards expose it in sysfs, and NVIDIA cards are queried with a short
 * `nvidia-smi` timeout. Missing hardware or drivers produce `null`, never invented
 * percentages.
 */
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface MachineGpuLoad {
  count: number
  /** Null when the driver exposes usage but not a product name. */
  name: string | null
  utilizationPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
  memoryUsedPercent: number | null
}

export interface MachineDiskLoad {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number | null
}

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
  /** Null when no GPU/driver exposes utilization or memory. */
  gpu: MachineGpuLoad | null
  /** Root filesystem usage; null when statfs is unavailable. */
  disk: MachineDiskLoad | null
  sampledAt: number
}

interface CpuTotals { idle: number; total: number; count: number }
interface GpuReading {
  name: string | null
  utilizationPercent: number | null
  memoryUsedBytes: number | null
  memoryTotalBytes: number | null
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function finiteNumber(value: unknown): number | null {
  // Number(null) and Number('') are 0; do not turn a missing sysfs file into a real 0%.
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
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

/** Read one small sysfs value; missing files are normal on unsupported drivers. */
function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8').trim() } catch { return null }
}

function readNonNegative(path: string): number | null {
  const value = finiteNumber(readText(path))
  return value != null && value >= 0 ? value : null
}

function gpuDriverName(device: string): string | null {
  const driver = /^DRIVER=(.+)$/m.exec(readText(`${device}/uevent`) ?? '')?.[1]?.trim()
  return whenDriverName(driver)
}

function whenDriverName(driver: string | null | undefined): string | null {
  if (!driver) return null
  if (driver === 'amdgpu') return 'AMD GPU'
  if (driver === 'i915' || driver === 'xe') return 'Intel GPU'
  if (driver === 'nouveau' || driver === 'nvidia') return 'NVIDIA GPU'
  return driver
}

/**
 * Linux DRM sysfs is the cheapest source and works for amdgpu/Intel without a
 * subprocess. Only cards that actually expose a usage or VRAM counter count, so
 * a display-only card node cannot create a fake GPU row.
 */
function readGpuSysfs(): GpuReading[] {
  if (process.platform !== 'linux') return []
  let entries: string[]
  try { entries = readdirSync('/sys/class/drm') } catch { return [] }
  return entries
    .filter(entry => /^card\d+$/.test(entry))
    .map(entry => {
      const device = `/sys/class/drm/${entry}/device`
      const utilization = readNonNegative(`${device}/gpu_busy_percent`)
      const used = readNonNegative(`${device}/mem_info_vram_used`)
      const total = readNonNegative(`${device}/mem_info_vram_total`)
      if (utilization == null && used == null && total == null) return null
      return {
        name: gpuDriverName(device),
        utilizationPercent: utilization != null ? round(Math.min(100, utilization)) : null,
        memoryUsedBytes: used,
        memoryTotalBytes: total,
      } satisfies GpuReading
    })
    .filter((item): item is GpuReading => item != null)
}

/**
 * NVIDIA exposes neither utilization nor VRAM counters in the generic DRM
 * sysfs. A fixed-argument `nvidia-smi` query is the supported fallback; the
 * timeout keeps a wedged driver from blocking the whole load request.
 */
async function readNvidiaSmi(): Promise<GpuReading[]> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true })
    return stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name, utilization, usedMiB, totalMiB] = line.split(',').map(part => part.trim())
        const utilizationPercent = finiteNumber(utilization)
        const used = finiteNumber(usedMiB)
        const total = finiteNumber(totalMiB)
        const reading: GpuReading = {
          name: name && name !== '[N/A]' ? name : null,
          utilizationPercent: utilizationPercent != null
            ? round(Math.max(0, Math.min(100, utilizationPercent))) : null,
          memoryUsedBytes: used != null && used >= 0 ? Math.round(used * 1024 * 1024) : null,
          memoryTotalBytes: total != null && total >= 0 ? Math.round(total * 1024 * 1024) : null,
        }
        return reading
      })
      .filter(reading => reading.utilizationPercent != null || reading.memoryUsedBytes != null || reading.memoryTotalBytes != null)
  } catch {
    return []
  }
}

function aggregateGpu(readings: GpuReading[]): MachineGpuLoad | null {
  if (readings.length === 0) return null
  const utilizations = readings
    .map(reading => reading.utilizationPercent)
    .filter((value): value is number => value != null)
  const used = readings
    .map(reading => reading.memoryUsedBytes)
    .filter((value): value is number => value != null)
  const total = readings
    .map(reading => reading.memoryTotalBytes)
    .filter((value): value is number => value != null)
  const usedBytes = used.length > 0 ? used.reduce((sum, value) => sum + value, 0) : null
  const totalBytes = total.length > 0 ? total.reduce((sum, value) => sum + value, 0) : null
  const names = [...new Set(readings.map(reading => reading.name).filter((name): name is string => !!name))]
  return {
    count: readings.length,
    name: names.length > 0 ? names.join(' + ') : null,
    utilizationPercent: utilizations.length > 0
      ? round(utilizations.reduce((sum, value) => sum + value, 0) / utilizations.length) : null,
    memoryUsedBytes: usedBytes,
    memoryTotalBytes: totalBytes,
    memoryUsedPercent: usedBytes != null && totalBytes != null && totalBytes > 0
      ? round((usedBytes / totalBytes) * 100) : null,
  }
}

async function readGpuLoad(): Promise<MachineGpuLoad | null> {
  const fromSysfs = readGpuSysfs()
  return aggregateGpu(fromSysfs.length > 0 ? fromSysfs : await readNvidiaSmi())
}

/** Use statfs instead of `df`; the path itself is never returned to clients. */
function readDiskLoad(): MachineDiskLoad | null {
  try {
    const stat = statfsSync(process.platform === 'win32' ? process.cwd() : '/')
    const blockSize = finiteNumber(stat.bsize)
    const blocks = finiteNumber(stat.blocks)
    const free = finiteNumber(stat.bfree)
    const available = finiteNumber(stat.bavail)
    if (blockSize == null || blocks == null || free == null || available == null) return null
    const totalBytes = Math.max(0, blocks * blockSize)
    const availableBytes = Math.max(0, Math.min(totalBytes, available * blockSize))
    const usedBytes = Math.max(0, Math.min(totalBytes, (blocks - free) * blockSize))
    if (totalBytes <= 0) return null
    // Match df's denominator: used + available excludes filesystem-reserved blocks.
    const denominator = usedBytes + availableBytes
    return {
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: denominator > 0 ? round((usedBytes / denominator) * 100) : null,
    }
  } catch {
    return null
  }
}

/**
 * Sample CPU over `sampleMs` and combine it with the kernel load average,
 * available memory, root disk usage and optional GPU counters. Kept short
 * (100 ms by default) so a refresh never waits on a full second.
 */
export async function readMachineLoad(sampleMs = 100): Promise<MachineLoad> {
  const first = cpuTotals()
  // Run the optional GPU probe alongside the CPU window rather than serializing
  // a possible 1.5 s nvidia-smi fallback after it.
  const gpuPromise = readGpuLoad()
  if (sampleMs > 0) await new Promise(resolve => setTimeout(resolve, sampleMs))
  const second = cpuTotals()
  const idle = second.idle - first.idle
  const total = second.total - first.total
  const cpuPercent = total > 0
    ? round(Math.max(0, Math.min(100, (1 - idle / total) * 100)))
    : null
  const load = os.loadavg()
  const memory = memoryTotals()
  const gpu = await gpuPromise
  return {
    cpuCount: second.count,
    cpuPercent,
    load1: Number.isFinite(load[0]) ? round(load[0], 2) : null,
    load5: Number.isFinite(load[1]) ? round(load[1], 2) : null,
    load15: Number.isFinite(load[2]) ? round(load[2], 2) : null,
    ...memory,
    gpu,
    disk: readDiskLoad(),
    sampledAt: Date.now(),
  }
}
