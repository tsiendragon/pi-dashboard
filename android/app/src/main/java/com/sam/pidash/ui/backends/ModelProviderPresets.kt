package com.sam.pidash.ui.backends

/** Defaults are editable; they only fill a form, never authenticate by themselves. */
internal data class ModelProviderPreset(
    val label: String,
    val id: String,
    val api: String,
    val baseUrl: String,
)

internal val modelProviderPresets = listOf(
    ModelProviderPreset("OpenAI", "openai", "openai-completions", "https://api.openai.com/v1"),
    ModelProviderPreset("Anthropic", "anthropic", "anthropic-messages", "https://api.anthropic.com"),
    ModelProviderPreset("DashScope", "dashscope", "openai-completions", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    ModelProviderPreset("OpenRouter", "openrouter", "openai-completions", "https://openrouter.ai/api/v1"),
    ModelProviderPreset("OpenCode Go", "opencode-go", "openai-completions", "https://opencode.ai/inference/go/v1"),
    ModelProviderPreset("DeepSeek", "deepseek", "openai-completions", "https://api.deepseek.com/v1"),
    ModelProviderPreset("MiniMax", "minimax", "anthropic-messages", "https://api.minimax.io/anthropic"),
    ModelProviderPreset("Gemini", "google", "google-generative-ai", "https://generativelanguage.googleapis.com"),
    ModelProviderPreset("Kimi / Moonshot", "moonshotai", "openai-completions", "https://api.moonshot.ai/v1"),
    ModelProviderPreset("GLM / Z.AI", "zai", "openai-completions", "https://open.bigmodel.cn/api/paas/v4"),
    ModelProviderPreset("OpenAI Codex（订阅）", "openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api"),
    ModelProviderPreset("自定义 / OpenAI 兼容", "custom", "openai-completions", ""),
)

internal val modelApiOptions = listOf(
    "openai-completions" to "OpenAI Chat Completions",
    "openai-responses" to "OpenAI Responses",
    "anthropic-messages" to "Anthropic Messages",
    "google-generative-ai" to "Google Generative AI",
    "openai-codex-responses" to "OpenAI Codex（订阅登录）",
)

internal fun modelProviderPreset(id: String): ModelProviderPreset? = modelProviderPresets.firstOrNull { it.id == id }
