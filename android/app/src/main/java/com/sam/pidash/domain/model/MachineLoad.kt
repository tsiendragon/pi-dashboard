package com.sam.pidash.domain.model

import kotlinx.serialization.Serializable

/**
 * Host pressure reported by `/api/system/load` on one Dashboard.
 *
 * The endpoint is deliberately separate from `/api/system`: the machine list
 * polls it while visible, so it must stay cheap and must not run `df`/`ps`.
 */
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
    val sampledAt: Long = 0,
)

/** UI state for one machine; a failed refresh keeps the last reading visible. */
data class MachineLoadState(
    val load: MachineLoad? = null,
    val loading: Boolean = false,
    val error: String? = null,
)
