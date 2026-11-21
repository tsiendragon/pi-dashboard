package com.sam.pidash.domain.model

import kotlinx.serialization.Serializable

/**
 * Host pressure reported by `/api/system/load` on one Dashboard.
 *
 * The endpoint is deliberately separate from `/api/system`: the machine list
 * polls it while visible, so it must stay cheap and must not run `df`/`ps`.
 * Disk uses statfs; NVIDIA GPU data uses a short fixed-argument nvidia-smi probe.
 */
@Serializable
data class MachineGpuLoad(
    val count: Int = 0,
    val name: String? = null,
    val utilizationPercent: Double? = null,
    val memoryUsedBytes: Long? = null,
    val memoryTotalBytes: Long? = null,
    val memoryUsedPercent: Double? = null,
)

@Serializable
data class MachineDiskLoad(
    val totalBytes: Long = 0,
    val usedBytes: Long = 0,
    val availableBytes: Long = 0,
    val usedPercent: Double? = null,
)

@Serializable
data class MachineLoad(
    val cpuCount: Int = 0,
    val cpuPercent: Double? = null,
    val load1: Double? = null,
    val load5: Double? = null,
    val load15: Double? = null,
    val memoryTotalBytes: Long = 0,
    val memoryUsedBytes: Long = 0,
    val memoryAvailableBytes: Long = 0,
    val memoryUsedPercent: Double? = null,
    /** Null when the host has no GPU or no driver exposes a useful counter. */
    val gpu: MachineGpuLoad? = null,
    /** Root filesystem usage; null when the server could not stat it. */
    val disk: MachineDiskLoad? = null,
    val sampledAt: Long = 0,
)

/** UI state for one machine; a failed refresh keeps the last reading visible. */
data class MachineLoadState(
    val load: MachineLoad? = null,
    val loading: Boolean = false,
    val error: String? = null,
)
