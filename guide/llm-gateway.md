# LLM Gateway 使用指南

LLM Gateway（大模型网关）让你用一个入口调用不同厂商的模型，可以用于 Pi、Codex CLI、Claude Code，也可以由程序直接调用。本文中的 Claude 指 Claude Code 命令行工具，不是 Claude 网页或桌面聊天客户端。

**需要 API Key（调用密钥），请联系管理员获取。不要把密钥发到群里、写进文档或提交到代码仓库。** 申请时也请确认你有权限使用的模型及额度。

## 1. 地址与准备工作

| 用途 | 地址 |
|---|---|
| 网关根地址 | `https://llm-gateway.example.com` |
| OpenAI 兼容接口的基础地址 | `https://llm-gateway.example.com/v1` |
| 查询模型 | `GET /v1/models` |
| 普通对话接口（Chat Completions） | `POST /v1/chat/completions` |
| Codex 使用的 Responses 接口 | `POST /v1/responses` |
| Claude Code 使用的 Messages 接口 | `POST /v1/messages` |

模型名称必须使用网关里的名称，不要自行套用官网名称。下面的示例模型来自本机现有网关配置，是否对你的密钥开放，以实际返回为准。**模型出现在列表里，不代表它支持以上所有接口。**

以下命令用于 Bash 终端。先安全输入密钥，不会在屏幕上显示，也不会把密钥正文写进命令历史：

```bash
read -r -s -p "请输入管理员发给你的 API Key: " LLM_GATEWAY_API_KEY
printf "\n"
export LLM_GATEWAY_API_KEY
```

变量只在当前终端及其启动的程序中有效。打开新终端需要重新设置；不要把含真实密钥的 `export` 命令粘贴到共享终端或文档。

先查询可用模型，确认网络和密钥正常：

```bash
curl --fail-with-body --silent --show-error \
  https://llm-gateway.example.com/v1/models \
  -H "Authorization: Bearer $LLM_GATEWAY_API_KEY"
```

返回模型列表后，再选择下面一种使用方式。

## 2. 在 Pi 中使用

编辑 `~/.pi/agent/models.json`。若已有配置，**只把 `llm-gateway` 合并到现有的 `providers` 中，不要覆盖其他配置**：

```json
{
  "providers": {
    "llm-gateway": {
      "baseUrl": "https://llm-gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$LLM_GATEWAY_API_KEY",
      "models": [
        { "id": "gpt-4o" },
        { "id": "claude-sonnet-5-5" },
        { "id": "gpt-6.1-sol", "api": "openai-responses" }
      ]
    }
  }
}
```

`apiKey` 里写的是环境变量引用，不是真实密钥；不要删掉 `$`。`openai-completions` 表示普通对话接口，`openai-responses` 表示 Responses 接口。Pi 可以通过网关的 OpenAI 兼容接口调用 Claude 模型，不必因为模型叫 Claude 就改成 Messages 接口。

在设置了密钥的同一个终端启动：

```bash
pi --provider llm-gateway --model gpt-4o
```

也可以在 Pi 中输入 `/model`，选择 `llm-gateway` 下的模型。Pi 打开模型选择菜单时会重新读取配置；如果 Pi 启动后才在另一个终端设置密钥，旧进程不会自动得到新变量，应从正确终端重新启动 Pi。

**通过 Dashboard 使用 Pi：**配置文件和密钥必须属于运行 Dashboard 服务的用户，服务进程也必须能读取该环境变量。浏览器无法读取你本地终端的变量。如需重新启动服务，由你自己在配置好变量的终端执行 `./run.sh` 或原有启动命令；重启会中断活跃会话。

## 3. 在 Codex CLI 中使用

Codex CLI 使用 Responses 接口，不是普通的 Chat Completions 接口。选择支持 Responses 的模型。

编辑 `~/.codex/config.toml`，合并以下配置；已有同名字段或配置段时修改原有内容，不要重复添加：

```toml
model_provider = "llm-gateway"
model = "gpt-6.1-sol"

[model_providers.llm-gateway]
name = "LLM Gateway"
base_url = "https://llm-gateway.example.com/v1"
env_key = "LLM_GATEWAY_API_KEY"
wire_api = "responses"
```

在已设置密钥的终端启动：

```bash
codex
```

此方式使用网关密钥，不依赖 ChatGPT 订阅登录。若原配置使用其他服务商或登录方式，保留原配置备份；不要为了切换网关删除已有登录文件。若提示不支持模型或接口，先确认模型有 Responses 权限，不能只把 `wire_api` 改成别的值来绕过。

## 4. 在 Claude Code 中使用

Claude Code 需要 Anthropic Messages 兼容接口。这里基础地址使用**网关根地址，不加 `/v1`**，客户端会自行拼接 `/v1/messages`。

用下面的命令只为这一次 Claude Code 进程设置变量，不改动其他终端的默认配置：

```bash
ANTHROPIC_BASE_URL="https://llm-gateway.example.com" \
ANTHROPIC_AUTH_TOKEN="$LLM_GATEWAY_API_KEY" \
ANTHROPIC_API_KEY="" \
claude --model claude-sonnet-5-5
```

这里用 `ANTHROPIC_AUTH_TOKEN` 发送 Bearer 密钥，并清空本次进程的 `ANTHROPIC_API_KEY`，避免旧密钥混用。若已有 Claude Code 设置或启动脚本注入其他地址、密钥或模型，也需要检查是否发生覆盖。不要把密钥写进项目的共享设置文件。

**前提：你的密钥和所选 Claude 模型已开通 Messages 接口。** 如果 Pi 中的 Claude 模型能用、Claude Code 却不能用，不能据此认定密钥失效：Pi 示例走的是另一种接口。请把不含密钥的错误信息发给管理员，确认 Messages 支持情况。

## 5. 单独调用 API

### 5.1 普通对话：curl

```bash
curl --fail-with-body --silent --show-error \
  https://llm-gateway.example.com/v1/chat/completions \
  -H "Authorization: Bearer $LLM_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "请用一句话介绍你自己"}]
  }'
```

回答在返回结果的 `choices[0].message.content` 中。

### 5.2 Responses 接口：curl

这一步可以单独检查 Codex 所需的接口是否可用：

```bash
curl --fail-with-body --silent --show-error \
  https://llm-gateway.example.com/v1/responses \
  -H "Authorization: Bearer $LLM_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6.1-sol",
    "input": "请回复：连接成功"
  }'
```

### 5.3 Messages 接口：curl

这一步可以单独检查 Claude Code 所需的接口是否可用：

```bash
curl --fail-with-body --silent --show-error \
  https://llm-gateway.example.com/v1/messages \
  -H "Authorization: Bearer $LLM_GATEWAY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5-5",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "请回复：连接成功"}]
  }'
```

### 5.4 Python：OpenAI SDK

在已有安装 `openai` 包的 Python 环境中运行：

```python
import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["LLM_GATEWAY_API_KEY"],
    base_url="https://llm-gateway.example.com/v1",
)
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "请用一句话介绍你自己"}],
)
answer = response.choices[0].message.content
```

`answer` 是模型回答，按你的程序需要使用。调用远端 API 不需要本机运行模型。

## 6. 常见问题

| 现象 | 先检查什么 |
|---|---|
| `401` | 密钥是否设置、是否过期；程序是否从设置变量的终端启动 |
| `403` | 该密钥的模型权限、访问策略或额度限制，联系管理员确认 |
| `404` 或模型不存在 | 地址是否重复拼了 `/v1`；模型名称是否准确；所用接口是否已开放 |
| `400` 或参数不支持 | 客户端所用接口与模型是否匹配；保留错误正文，不要盲目换参数 |
| `429` | 请求过快或额度受限；减少并发，稍后重试，持续出现则联系管理员 |
| 超时、无法连接 | 当前机器能否访问网关域名；网络或代理设置是否正确 |
| Pi 中看不到模型 | JSON 是否有效、配置是否合并正确、密钥变量是否传入 Pi 进程 |
| 普通问答成功，但工具调用失败 | 问答通过不等于编程工具可用；需核对工具调用和流式返回的兼容性 |

报错求助时，请提供使用的客户端、模型名、接口路径、发生时间和已去掉密钥的错误信息。不要分享完整环境变量、认证文件或带密钥的请求日志。

## 7. 本文核对范围

- 网关地址和示例模型取自当前机器的 Pi 网关配置；Pi 配置格式已对照已安装版本的说明。
- 未带密钥访问 `/v1/models` 返回 `401`；对 `/v1/responses` 和 `/v1/messages` 的 GET 探测返回 `405`。这只能说明服务有响应，**不能证明对应 POST 请求、模型权限或客户端兼容性已验证**。
- 本次没有使用真实密钥执行模型调用。Codex、Claude Code、流式返回和工具调用尚未端到端验证；首次接入请依次做模型查询、对应接口的简单问答，再尝试实际编程任务。
