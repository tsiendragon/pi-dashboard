# 表情包模型选择与实测

## 目标与范围

- 页面按服务商和模型选择，提交已登记的模型标识；后端白名单拒绝未知模型、跨服务商模型和未接入的参考图模式。
- `t2i`：输入文字，生成图片。`it2i`：输入参考图和文字，生成新图片。
- 先接入 12 个有明确请求合同的常用非日期快照型号，共 21 个已接入的模型/模式组合。目录中其他型号不自动开放，尤其不把可见目录误当成已有部署或接口兼容。
- 本页未接入参考图不等于模型理论上不具备该能力。FLUX.2、MAI 依据 Toolkit 当前公开方法只接入文字生成。
- 不修改受保护 `.env`，不重启服务，不重复收费重试。单独模型请求会覆盖本次调用所用的模型，不更改服务器环境或其他用户选择。

## 接入清单

| 服务 | 型号 | 本页接入模式 |
|---|---|---|
| DashScope | qwen-image-3.0 | t2i、it2i |
| DashScope | qwen-image-3.0-pro | t2i、it2i |
| DashScope | qwen-image-2.0 | t2i、it2i |
| DashScope | qwen-image-2.0-pro | t2i、it2i |
| DashScope | z-image-turbo | t2i |
| Azure | gpt-image-2.5-sunburst | t2i、it2i |
| Azure | gpt-image-2.5-flare | t2i、it2i |
| Azure | gpt-image-2 | t2i、it2i |
| Azure | gpt-image-1.5 | t2i、it2i |
| Azure | FLUX.1-Kontext-pro | t2i、it2i |
| Azure | FLUX.2-pro | t2i（参考图未接入） |
| Azure | MAI-Image-2e | t2i（参考图未接入） |

## 实测方案

- 使用与页面相同的 `generateMeme` 和白名单路由；每个已接入组合最多发起一次生成，不因失败重试。
- 文字测试统一生成白底开心橘猫；参考图测试统一输入已有 1024×1024 橘猫 PNG，要求保留猫并加红色帽子，不含真实个人数据。
- 并行上限 3；临时图片、结果和命令存外部独立目录，不覆盖上一轮证据。
- 出图通过要求：生成响应成功、取得并保存 PNG/JPEG/WebP 实际图片；保存结果与状态逐项记录。API 成功不自动等于参考图形象保留或质量优秀，图片另行自审。
- 页面按模型/模式显示实测通过、失败或未测及日期；失败结果不隐藏，不将未测试能力标成可用。
- 状态：真实调用与全部成功图片的解码/逐项缩略图检查已完成。最终后台 30 项、前端 14 项测试，以及前后端类型、环境文档和差异空白检查均通过；包括白名单、模式拒绝、FLUX/MAI 请求格式、所选模型发送、切换清图、价格对应和资源指纹隔离。日志 `/tmp/pi-background/f5e3f9055cfa1564-726120/bash-070c.log`。未部署或重启，浏览器实际宽窄屏与主题视觉效果尚未检查。安装、配置和部署仍只见 `guide/`。

## 真实结果（2026-10-19）

| 模型 | 文字生成 | 参考图加文字 |
|---|---|---|
| Qwen Image 3.0 | 通过，49.38 秒 | 通过，46.05 秒 |
| Qwen Image 3.0 Pro | 通过，40.98 秒 | 通过，116.72 秒 |
| Qwen Image 2.0 | 通过，121.46 秒 | 通过，126.75 秒 |
| Qwen Image 2.0 Pro | 通过，54.83 秒 | 通过，58.10 秒 |
| Z-Image Turbo | 通过，53.40 秒 | 本页未接入 |
| GPT Image 2.5 Sunburst | 通过，25.27 秒 | 通过，35.26 秒 |
| GPT Image 2.5 Flare | 404，未找到部署 | 404，未找到部署 |
| GPT Image 2 | 通过，39.00 秒 | 通过，74.75 秒 |
| GPT Image 1.5 | 通过，89.83 秒 | 429，本次限流，不能据此判定不支持 |
| FLUX.1 Kontext Pro | HTTP 200 返回图片，但要求橘猫却画了山水，内容检查失败 | HTTP 200 返回猫图，但没有加红帽，内容检查失败 |
| FLUX.2 Pro | 通过，5.29 秒 | 本页当前接口未接入，不等于模型本身不支持 |
| MAI Image 2e | 通过，16.46 秒 | 本页当前接口未接入，不等于模型本身不支持 |

- 21 个组合各 1 次真实生成请求，无重试。18 次取得有效图片、3 次 HTTP 失败；逐项查看 18 张后，16 项内容符合本次要求，2 项 Kontext 内容不符。页面最终记录 16 项通过、5 项未通过，保留 HTTP 200 与具体内容失败原因，不把返回图片当成质量合格。
- 指标只代表这一轮小样例，不能推断成功率、普遍质量或稳定时延。没有用单次限流推断 GPT Image 1.5 不具备编辑能力。
- 命令：`./node_modules/.bin/tsx /tmp/pi-meme-matrix-selectable-models-r1/run.mts`；后台任务 `bash-d370`；并行 3。此脚本含 `.started` 防重复标志，禁止再次运行追加收费请求。
- 证据目录 `/tmp/pi-meme-matrix-selectable-models-r1/`：`summary.json`、21 份模式结果 JSON、18 张图片、`t2i-review.jpg` 和 `it2i-review.jpg`；日志 `/tmp/pi-background/f5e3f9055cfa1564-726120/bash-d370.log`。Pillow 完整解码了 18 张，随后逐项查看两张联系表（非抽样），其中参考图表含输入原图。
- 页面状态源为 `backend/meme-model-checks.ts`，以资源地址指纹约束，不写密钥、资源域名或签名图片链接，不会把结果套到其他资源。
- 默认和模型切换无需再修改受保护的 `.env`：页面发送显式模型标识，旧环境默认只用于兼容旧调用。仍需用户自行 `./run.sh` 构建/重启生效；本轮未操作线上服务。

## 追加 FLUX 版本检查（2026-10-19）

用户授权检查其他 FLUX 型号。本轮 Azure 模型目录返回 HTTP 200，FLUX 仅列出 `FLUX-1.1-pro`、`FLUX.1-Kontext-pro`、`FLUX.2-pro`、`FLUX.2-flex`；未列出 Dev、Schnell，未猜测部署名盲试。

| 本轮组合 | 真实结果 | 内容检查 |
|---|---|---|
| FLUX-1.1-pro 文字生成 | HTTP 200，4.37 秒 | 通过：白底开心橘猫 |
| FLUX.2-flex 文字生成 | HTTP 404，DeploymentNotFound，1.64 秒 | 无图片，当前资源未找到部署 |
| FLUX.2-flex 参考图加文字 | HTTP 404，DeploymentNotFound，2.86 秒 | 无图片，当前资源未找到部署 |
| FLUX.2-pro 参考图加文字 | HTTP 200，7.58 秒 | 通过：原猫加红帽，保留原姿态和表情 |

- 本轮 4 次真实生成请求，各组合仅 1 次、无重试；2 次返回图片，两张完整图片均已逐张查看。没有重复上一轮已测的文字生成组合。
- 使用官方 Foundry BFL 路由 `/providers/blackforestlabs/v1/{model-path}?api-version=preview`，1.1 Pro 路径为 `flux-pro-1.1`，Flex 为 `flux-2-flex`；参考图使用 `input_image` base64。依据：https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-flux 。
- 本轮使用英文描述，上一轮页面调用包含中文描述；不能将两轮差异直接归因于模型优劣。未重复测试 Kontext，也未确定其此前内容错误的根因。
- 命令 `./node_modules/.bin/tsx /tmp/pi-flux-extra-r1/run.mts`，后台任务 `bash-f064`，防重复标志 `.started`。证据 `/tmp/pi-flux-extra-r1/summary.json`、4 份结果 JSON、2 张 JPEG；日志 `/tmp/pi-background/f5e3f9055cfa1564-726120/bash-f064.log`。不保存密钥或签名 URL。
- 此次检查时仅记录，没有修改页面/后端接入、`.env` 或运行服务；当时 FLUX.2-pro 参考图模式未开放，1.1 Pro 尚未加入下拉菜单。后续接入见下节。未取得 Azure 账单单价，不估算费用。

## 将已通过型号接入页面（2026-10-19）

- 新增 `FLUX-1.1-pro` 白名单与文字生成路由，开放 `FLUX.2-pro` 的参考图上传/编辑。页面由服务端模型清单驱动，无需改动页面实现。现有清单共 13 个型号、23 个已接入模式。
- BFL 请求采用实测字段 `num_images: 1`、`output_format: jpeg`，参考图用 `input_image` base64；1.1 Pro 使用 `flux-pro-1.1` 路径。1.1 Pro 不接受参考图，在发请求前拒绝。
- 复用上轮 4.37 秒和 7.58 秒的真实结果；记录仍按资源指纹隔离。BFL 提示词前缀采用英文，说明追加实测仅用了英文描述，没有自动翻译用户输入或保证中文效果。
- 没有再发起收费调用，没有新增环境变量、修改 `.env`、提交或重启。保留既有失败型号的提示，不增加未找到部署的 Flex。
- 验收：前后端类型检查、后台 30 项测试通过（`bash-266d`）；前端 15 项、环境文档 35 项变量检查与差异空白检查通过（`bash-fd62`）。新增前端用例最初误用首次生成按钮名，已按实际的「再生成一张」修正并全部通过。当前资源元数据检查确认 13 个型号、23 个模式，新增型号/模式均显示已有真实通过记录。需要用户自行部署，浏览器视觉检查未执行。
