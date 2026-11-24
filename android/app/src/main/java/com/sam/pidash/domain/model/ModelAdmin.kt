package com.sam.pidash.domain.model

import kotlinx.serialization.Serializable

/** A models.json provider as exposed by the Dashboard; secrets never come back. */
@Serializable
data class ModelProvider(
    val id: String,
    val api: String = "",
    val baseUrl: String = "",
    val hasKey: Boolean = false,
    val keySource: String = "none",
    val models: List<ModelDefinition> = emptyList(),
    val piAuth: Boolean = false,
)

@Serializable
data class ModelDefinition(
    val id: String,
    val name: String? = null,
    val contextWindow: Long = 0,
    val maxTokens: Long = 0,
    val reasoning: Boolean = false,
    val input: List<String> = listOf("text"),
)

@Serializable
data class ModelProviderRequest(
    val api: String,
    val baseUrl: String,
    val apiKey: String? = null,
    val models: List<ModelDefinition> = emptyList(),
)

@Serializable
data class ModelProviderSaveResult(
    val provider: ModelProvider,
    val allowlistChanged: Boolean = false,
    val requiresSessionRestart: Boolean = true,
)
