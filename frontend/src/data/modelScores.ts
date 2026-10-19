/**
 * 模型能力分数快照 — 数据来源 Artificial Analysis（artificialanalysis.ai）。
 * 抓取时间 2026-10-14。分数口径（分数为 AA 对各模型默认/最高推理档的评测）：
 *  - intelligenceIndex：AA 智能指数（0-100，跨领域综合能力）
 *  - terminalBench40：Terminal-Bench 4.0 智能体终端任务胜率（%），最贴近 agentic coding
 *  - frontierCode：FrontierCode 开源仓库真实工单「维护者会合并」比例（%），智能体软件工程
 *  - terminalBench21：Terminal-Bench 2.1（上一代基准，%）
 * ourModels 关联本机启用的 provider/model（~/.pi/agent/settings.json enabledModels），
 * 用于与真实成本/速度联表；没有分数的模型（如 Qwen3 Coder Plus）表示 AA 未收录。
 * ourModels 为空表示本机未启用（旧一代 gpt-5.6-* 与 gpt-6-sol 已从 provider 配置下线）；
 * provider/model key 沿用远端已有 canonical provider 名称；不为未配置模型补造关联。
 * 更新方式：从 AA 模型页抓取（RSC 数据）后重新生成本文件。
 */

export const SCORE_SNAPSHOT_DATE = '2026-10-14'
export const SCORE_SOURCE_URL = 'https://artificialanalysis.ai/models'

export interface ModelScore {
  slug: string
  name: string
  creator: string
  releaseDate?: string
  intelligenceIndex?: number
  terminalBench40?: number
  frontierCode?: number
  terminalBench21?: number
  /** 本机启用的 provider/model key，用于联表真实成本与速度 */
  ourModels: string[]
}

export const MODEL_SCORES: ModelScore[] = [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", creator: "Anthropic", releaseDate: "2026-09-22", intelligenceIndex: 57.6, terminalBench40: 59.6, frontierCode: 52.2, ourModels: ["llm-gateway/claude-opus-5-5", "azure-proxy/claude-opus-5-5"] },
  { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", creator: "Anthropic", releaseDate: "2026-09-28", intelligenceIndex: 56.0, terminalBench40: 63.6, frontierCode: 45.8, ourModels: ["llm-gateway/claude-sonnet-5-5", "azure-proxy/claude-sonnet-5-5"] },
  { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", creator: "Anthropic", releaseDate: "2026-10-07", intelligenceIndex: 43.4, terminalBench40: 32.8, frontierCode: 41.8, ourModels: ["azure-proxy/claude-haiku-5-5"] },
  { slug: "gpt-6-astra", name: "GPT-6 Astra", creator: "OpenAI", releaseDate: "2026-09-03", intelligenceIndex: 52.7, terminalBench40: 59.1, frontierCode: 47.0, terminalBench21: 88.4, ourModels: ["llm-gateway/gpt-6-astra", "azure-proxy/gpt-6-astra"] },
  { slug: "gpt-6-1-sol", name: "GPT-6.1 Sol", creator: "OpenAI", releaseDate: "2026-09-29", intelligenceIndex: 51.8, terminalBench40: 56.1, frontierCode: 49.1, ourModels: ["llm-gateway/gpt-6.1-sol", "azure-proxy/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"] },
  { slug: "gpt-6-sol", name: "GPT-6 Sol", creator: "OpenAI", releaseDate: "2026-09-22", intelligenceIndex: 47.6, terminalBench40: 43.9, ourModels: [] },
  { slug: "gpt-6-luna", name: "GPT-6 Luna", creator: "OpenAI", releaseDate: "2026-09-22", intelligenceIndex: 38.1, terminalBench40: 12.6, frontierCode: 41.9, ourModels: ["llm-gateway/gpt-6-luna", "azure-proxy/gpt-6-luna", "openai-codex/gpt-6-luna"] },
  { slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", creator: "OpenAI", releaseDate: "2026-07-09", intelligenceIndex: 47.0, terminalBench40: 39.9, terminalBench21: 88.0, ourModels: [] },
  { slug: "gpt-5-6-terra", name: "GPT-5.6 Terra", creator: "OpenAI", releaseDate: "2026-07-09", intelligenceIndex: 42.1, terminalBench40: 35.4, terminalBench21: 88.0, ourModels: [] },
  { slug: "gpt-5-6-luna", name: "GPT-5.6 Luna", creator: "OpenAI", releaseDate: "2026-07-09", intelligenceIndex: 37.3, terminalBench40: 11.6, terminalBench21: 80.9, ourModels: [] },
  { slug: "kimi-k3", name: "Kimi K3", creator: "Kimi", releaseDate: "2026-07-16", intelligenceIndex: 43.6, terminalBench40: 12.6, frontierCode: 43.6, terminalBench21: 85.0, ourModels: ["llm-gateway/kimi-k3", "dashscope/kimi-k3"] },
  { slug: "kimi-k2-7-code", name: "Kimi K2.7 Code", creator: "Kimi", releaseDate: "2026-06-12", intelligenceIndex: 25.8, terminalBench40: 1.0, terminalBench21: 67.4, ourModels: ["dashscope/kimi-k2.7-code"] },
  { slug: "glm-5-3", name: "GLM-5.3", creator: "Z AI", releaseDate: "2026-08-18", intelligenceIndex: 44.8, terminalBench40: 41.9, frontierCode: 40.1, terminalBench21: 83.9, ourModels: ["llm-gateway/glm-5.3"] },
  { slug: "glm-5-3-flash", name: "GLM-5.3-Flash", creator: "Z AI", releaseDate: "2026-08-26", intelligenceIndex: 41.8, terminalBench40: 32.8, frontierCode: 41.0, terminalBench21: 84.3, ourModels: ["llm-gateway/glm-5.3-flash"] },
  { slug: "qwen3-8-max", name: "Qwen3.8 Max (0902)", creator: "Alibaba", releaseDate: "2026-09-02", intelligenceIndex: 45.4, terminalBench40: 38.9, frontierCode: 43.2, terminalBench21: 88.8, ourModels: ["dashscope/qwen3.8-max"] },
  { slug: "qwen3-8-flash-next", name: "Qwen3.8 Flash (Next)", creator: "Alibaba", releaseDate: "2026-08-26", intelligenceIndex: 39.8, terminalBench40: 25.3, terminalBench21: 86.1, ourModels: ["dashscope/qwen3.8-flash"] },
  { slug: "deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash", creator: "DeepSeek", releaseDate: "2026-09-10", intelligenceIndex: 39.5, terminalBench40: 26.8, frontierCode: 44.0, ourModels: ["dashscope/deepseek-v4.1-flash", "dsw/deepseek_v41_flash"] },
  { slug: "deepseek-v4-pro", name: "DeepSeek V4 Pro 0813", creator: "DeepSeek", releaseDate: "2026-08-13", intelligenceIndex: 36.0, terminalBench40: 14.1, terminalBench21: 78.7, ourModels: ["dashscope/deepseek-v4-pro-0813"] },
  { slug: "deepseek-v4-flash", name: "DeepSeek V4 Flash 0731", creator: "DeepSeek", releaseDate: "2026-07-31", intelligenceIndex: 34.3, terminalBench40: 12.1, terminalBench21: 78.7, ourModels: ["dashscope/deepseek-v4-flash"] },
  { slug: '', name: "Qwen3 Coder Plus", creator: 'Alibaba', ourModels: ["dashscope/qwen3-coder-plus"] },
  { slug: "claude-fable-5-1", name: "Claude Fable 5.1", creator: "Anthropic", releaseDate: "2026-09-01", intelligenceIndex: 53.4, terminalBench40: 52.0, frontierCode: 49.0, terminalBench21: 91.4, ourModels: [] },
  { slug: "gemini-4-argon", name: "Gemini 4 Argon", creator: "Google", releaseDate: "2026-09-30", intelligenceIndex: 52.6, terminalBench40: 57.1, frontierCode: 42.6, ourModels: [] },
  { slug: "muse-wonder-full", name: "Muse Wonder Full", creator: "Meta", releaseDate: "2026-10-12", intelligenceIndex: 55.8, terminalBench40: 57.1, ourModels: [] },
  { slug: "muse-wonder", name: "Muse Wonder", creator: "Meta", releaseDate: "2026-10-12", intelligenceIndex: 52.4, terminalBench40: 52.0, ourModels: [] },
  { slug: "muse-spark-1-3", name: "Muse Spark 1.3", creator: "Meta", releaseDate: "2026-09-02", intelligenceIndex: 48.1, terminalBench40: 33.3, frontierCode: 40.6, terminalBench21: 84.3, ourModels: [] },
  { slug: "grok-4-7", name: "Grok 4.7", creator: "SpaceXAI", releaseDate: "2026-09-21", intelligenceIndex: 46.4, terminalBench40: 25.8, frontierCode: 33.8, ourModels: [] },
  { slug: "mimo-v2-6-pro", name: "MiMo-V2.6-Pro", creator: "Xiaomi", releaseDate: "2026-09-21", intelligenceIndex: 46.3, terminalBench40: 34.8, frontierCode: 45.4, ourModels: [] },
  { slug: "step-5", name: "Step 5 Preview", creator: "StepFun", releaseDate: "2026-09-18", intelligenceIndex: 43.7, terminalBench40: 33.3, frontierCode: 38.4, ourModels: [] },
  { slug: "gemini-3-8-flash", name: "Gemini 3.8 Flash", creator: "Google", releaseDate: "2026-09-02", intelligenceIndex: 40.9, terminalBench40: 19.7, frontierCode: 36.4, terminalBench21: 87.6, ourModels: [] },
  { slug: "minimax-m3", name: "MiniMax-M3", creator: "MiniMax", releaseDate: "2026-06-01", intelligenceIndex: 29.2, terminalBench40: 2.0, frontierCode: 23.0, terminalBench21: 65.2, ourModels: [] },
]
