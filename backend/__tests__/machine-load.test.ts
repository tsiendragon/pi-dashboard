import { describe, expect, it } from 'vitest'
import { readMachineLoad } from '../machine-load.js'

describe('readMachineLoad', () => {
  it('returns bounded CPU, load and memory metrics', async () => {
    const sample = await readMachineLoad(10)
    expect(Number.isInteger(sample.cpuCount)).toBe(true)
    expect(sample.cpuCount).toBeGreaterThanOrEqual(0)
    expect(sample.sampledAt).toBeGreaterThan(0)
    expect(sample.memoryTotalBytes).toBeGreaterThan(0)
    expect(sample.memoryUsedBytes).toBeGreaterThanOrEqual(0)
    expect(sample.memoryUsedBytes).toBeLessThanOrEqual(sample.memoryTotalBytes)
    expect(sample.memoryAvailableBytes).toBeGreaterThanOrEqual(0)
    expect(sample.memoryAvailableBytes).toBeLessThanOrEqual(sample.memoryTotalBytes)
    if (sample.memoryUsedPercent != null) {
      expect(sample.memoryUsedPercent).toBeGreaterThanOrEqual(0)
      expect(sample.memoryUsedPercent).toBeLessThanOrEqual(100)
    }
    if (sample.cpuPercent != null) {
      expect(sample.cpuPercent).toBeGreaterThanOrEqual(0)
      expect(sample.cpuPercent).toBeLessThanOrEqual(100)
    }
    for (const value of [sample.load1, sample.load5, sample.load15]) {
      if (value != null) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('never reports unavailable counters as invented numbers', async () => {
    const sample = await readMachineLoad(0)
    expect(sample.memoryUsedBytes + sample.memoryAvailableBytes).toBeLessThanOrEqual(sample.memoryTotalBytes)
    if (sample.cpuCount === 0) expect(sample.cpuPercent).toBeNull()
  })
})
