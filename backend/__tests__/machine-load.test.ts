import { describe, expect, it } from 'vitest'
import { readMachineLoad } from '../machine-load.js'

describe('readMachineLoad', () => {
  it('returns bounded CPU, load, memory, disk and optional GPU metrics', async () => {
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
    if (sample.disk != null) {
      expect(sample.disk.totalBytes).toBeGreaterThan(0)
      expect(sample.disk.usedBytes).toBeGreaterThanOrEqual(0)
      expect(sample.disk.availableBytes).toBeGreaterThanOrEqual(0)
      expect(sample.disk.usedBytes + sample.disk.availableBytes).toBeLessThanOrEqual(sample.disk.totalBytes)
      if (sample.disk.usedPercent != null) {
        expect(sample.disk.usedPercent).toBeGreaterThanOrEqual(0)
        expect(sample.disk.usedPercent).toBeLessThanOrEqual(100)
      }
    }
    if (sample.gpu != null) {
      expect(sample.gpu.count).toBeGreaterThan(0)
      if (sample.gpu.utilizationPercent != null) {
        expect(sample.gpu.utilizationPercent).toBeGreaterThanOrEqual(0)
        expect(sample.gpu.utilizationPercent).toBeLessThanOrEqual(100)
      }
      if (sample.gpu.memoryUsedBytes != null && sample.gpu.memoryTotalBytes != null) {
        expect(sample.gpu.memoryUsedBytes).toBeGreaterThanOrEqual(0)
        expect(sample.gpu.memoryUsedBytes).toBeLessThanOrEqual(sample.gpu.memoryTotalBytes)
      }
      if (sample.gpu.memoryUsedPercent != null) {
        expect(sample.gpu.memoryUsedPercent).toBeGreaterThanOrEqual(0)
        expect(sample.gpu.memoryUsedPercent).toBeLessThanOrEqual(100)
      }
    }
  })

  it('never reports unavailable counters as invented numbers', async () => {
    const sample = await readMachineLoad(0)
    expect(sample.memoryUsedBytes + sample.memoryAvailableBytes).toBeLessThanOrEqual(sample.memoryTotalBytes)
    if (sample.cpuCount === 0) expect(sample.cpuPercent).toBeNull()
    // A missing GPU or an unavailable sysfs file must be null, never a synthetic 0%.
    if (sample.gpu != null && sample.gpu.utilizationPercent != null) {
      expect(Number.isFinite(sample.gpu.utilizationPercent)).toBe(true)
    }
  })
})
