#!/usr/bin/env bash
#
# install-standalone.sh — 在干净机器上装一套「pi-dashboard + 配套扩展」。
#
# 只装通用能力：pi-dashboard + pi-tsien-extension（含 vendored pi-web-tools）。
# 不装内部 marketplace 包（task-pilot / taskspace / eagleeye-kyc-llm / security-guard 等）。
#
# 用法：
#   bash scripts/install-standalone.sh                 # 交互式，默认装到 ~/pi-stack
#   bash scripts/install-standalone.sh -y              # 不确认，直接执行
#   bash scripts/install-standalone.sh --start         # 装完顺手后台启动
#   bash scripts/install-standalone.sh --service       # 装成 systemd 服务（需 sudo）
#   bash scripts/install-standalone.sh --dry-run       # 只打印将要执行的步骤
#   bash scripts/install-standalone.sh --official-pi   # 改装官方 npm 版 pi（默认装 fork Release 构建）
#
# 详细说明见 docs/standalone-install.md。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_DASHBOARD_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DASHBOARD_DIR=""
ROOT_DIR="${HOME}/pi-stack"
EXT_DIR=""
EXT_REPO="https://github.com/tsiendragon/pi-tsien-extension.git"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
PORT="${PI_DASH_PORT:-7777}"
INSTALL_PI=""
INSTALL_PI_VERSION=""
PI_SOURCE="release"
PI_RELEASE_REPO="${PI_RELEASE_REPO:-tsiendragon/pi}"
PI_RELEASE_TAG="${PI_RELEASE_TAG:-v0.85.1-tsien.1}"
PI_PREFIX=""
ASSUME_YES=0
DRY_RUN=0
DO_START=0
DO_SERVICE=0
SKIP_SYNC=0

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

usage() {
  sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

选项:
  --dir <path>            克隆/安装根目录（默认 ~/pi-stack）
  --dashboard-dir <path>  复用已有的 pi-dashboard checkout（默认脚本所在仓库）
  --ext-dir <path>        复用已有的 pi-tsien-extension checkout
  --ext-repo <url>        扩展仓库地址（默认 GitHub tsiendragon/pi-tsien-extension）
  --agent-dir <path>      Pi agent 配置目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）
  --port <n>              dashboard 端口（默认 7777）
  --install-pi [version]  等同 --official-pi：全局安装官方 npm 版 pi
  --official-pi [version] 安装官方 npm 版 pi（默认不装；不带版本用 latest）
  --pi-release <repo@tag> 从 GitHub Release 装 fork 构建的 pi
                          （默认 tsiendragon/pi@v0.85.1-tsien.1，含 dashboard 需要的扩展 API）
  --pi-prefix <path>      fork 版 pi 的安装前缀（默认 <安装根>/pi）
  --skip-pi               完全不安装 pi（自己已有可用的 pi 时）
  --skip-extension-sync   只装 dashboard，不动 Pi 的扩展配置
  --service               安装 systemd 服务（需要 sudo）
  --start                 装完后后台启动 dashboard
  -y, --yes               不交互确认
  --dry-run               只打印步骤
  -h, --help              显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) ROOT_DIR="$2"; shift 2 ;;
    --dashboard-dir) DASHBOARD_DIR="$2"; shift 2 ;;
    --ext-dir) EXT_DIR="$2"; shift 2 ;;
    --ext-repo) EXT_REPO="$2"; shift 2 ;;
    --agent-dir) AGENT_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --install-pi|--official-pi) PI_SOURCE="official"; INSTALL_PI=1; if [[ $# -ge 2 && "$2" != -* ]]; then INSTALL_PI_VERSION="$2"; shift; fi; shift ;;
    --pi-release)
      PI_SOURCE="release"
      [[ $# -ge 2 ]] || die "--pi-release 需要 <repo@tag>"
      if [[ "$2" == *@* ]]; then
        PI_RELEASE_REPO="${2%%@*}"; PI_RELEASE_TAG="${2##*@}"
      else
        PI_RELEASE_REPO="$2"
      fi
      shift 2 ;;
    --pi-prefix) PI_PREFIX="$2"; shift 2 ;;
    --skip-pi) PI_SOURCE="skip"; shift ;;
    --skip-extension-sync) SKIP_SYNC=1; shift ;;
    --service) DO_SERVICE=1; shift ;;
    --start) DO_START=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1 （-h 查看帮助）" ;;
  esac
done

confirm() {
  [[ "${ASSUME_YES}" == "1" || "${DRY_RUN}" == "1" ]] && return 0
  read -r -p "$1 [y/N] " reply
  [[ "${reply}" =~ ^[Yy]$ ]]
}

# ── 1. 依赖检查 ───────────────────────────────────────────────────────────────
log "检查依赖"
command -v git >/dev/null || die "缺少 git"
command -v node >/dev/null || die "缺少 node（需要 22+）"
command -v npm >/dev/null || die "缺少 npm"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge 22 ]] || die "node 版本过低：$(node -v)，需要 22+"
log "node $(node -v) / npm $(npm -v)"

if ! command -v python3 >/dev/null || ! command -v make >/dev/null; then
  warn "缺少 python3/make/g++ 时 node-pty 无法编译；Debian/Ubuntu 可执行: sudo apt install -y build-essential python3"
fi

# ── 2. 目录解析 ───────────────────────────────────────────────────────────────
DASHBOARD_DIR="${DASHBOARD_DIR:-${DEFAULT_DASHBOARD_DIR}}"
[[ -f "${DASHBOARD_DIR}/package.json" ]] || die "不是 pi-dashboard 仓库: ${DASHBOARD_DIR}"
EXT_DIR="${EXT_DIR:-${PI_TSIEN_EXTENSION_ROOT:-${ROOT_DIR}/pi-tsien-extension}}"
AGENT_DIR="$(cd "${AGENT_DIR}" 2>/dev/null && pwd || echo "${AGENT_DIR}")"

log "dashboard : ${DASHBOARD_DIR}"
log "extension : ${EXT_DIR}"
log "agent dir : ${AGENT_DIR}"
log "port      : ${PORT}"

# ── 3. 取扩展仓库 ─────────────────────────────────────────────────────────────
if [[ -f "${EXT_DIR}/config/extensions.standalone.json" ]]; then
  log "复用已有扩展仓库"
else
  log "克隆扩展仓库 → ${EXT_DIR}"
  run mkdir -p "$(dirname "${EXT_DIR}")"
  run git clone --depth 1 "${EXT_REPO}" "${EXT_DIR}"
fi

if [[ "${SKIP_SYNC}" == "0" ]]; then
  [[ -f "${EXT_DIR}/config/extensions.standalone.json" ]] \
    || die "扩展仓库缺少 config/extensions.standalone.json，请更新仓库或加 --skip-extension-sync"

  # ── 4. 安装扩展依赖 ─────────────────────────────────────────────────────────
  log "安装扩展依赖 (npm install)"
  run npm --prefix "${EXT_DIR}" install --no-audit --no-fund

  # ── 5. 应用 Pi 扩展配置 ─────────────────────────────────────────────────────
  EXISTING_CONFIG="${AGENT_DIR}/extensions.config.json"
  if [[ -f "${EXISTING_CONFIG}" ]]; then
    if grep -qE 'task-pilot|EAGLEEYE|security-guard|remote-notifications' "${EXISTING_CONFIG}" \
       && ! grep -q 'standalone' "${EXISTING_CONFIG}"; then
      warn "检测到已有配置引用了 marketplace/业务扩展：${EXISTING_CONFIG}"
      warn "应用 standalone 配置会把 Pi 设置里的 package/extension 严格收敛为通用集合。"
      confirm "确认继续？" || die "已取消（未修改任何 Pi 配置）"
    fi
    BACKUP="${EXISTING_CONFIG}.bak-$(date +%Y%m%d%H%M%S)"
    log "备份原配置 → ${BACKUP}"
    run cp "${EXISTING_CONFIG}" "${BACKUP}"
  fi

  log "写扩展配置"
  run mkdir -p "${AGENT_DIR}"
  run cp "${EXT_DIR}/config/extensions.standalone.json" "${EXISTING_CONFIG}"

  SYNC=(node "${EXT_DIR}/scripts/pi-extension-sync.mjs")
  log "预览同步结果"
  run env PI_TSIEN_EXTENSION_ROOT="${EXT_DIR}" "${SYNC[@]}"
  if confirm "应用上面的扩展配置？"; then
    run env PI_TSIEN_EXTENSION_ROOT="${EXT_DIR}" "${SYNC[@]}" --apply
    log "扩展配置已应用（Pi 需 /reload 或重启后生效）"
  else
    warn "已跳过应用；配置已写入 ${EXISTING_CONFIG}，可稍后手动执行 --apply"
  fi
fi

# ── 6. 安装 dashboard 依赖并构建前端 ──────────────────────────────────────────
log "安装 dashboard 依赖 (npm install)"
run bash -lc "cd '${DASHBOARD_DIR}' && npm install --no-audit --no-fund"

[[ -d "${DASHBOARD_DIR}/frontend" ]] || die "缺少 frontend 目录"
log "构建前端 (npm run build-frontend)"
run bash -lc "cd '${DASHBOARD_DIR}' && npm run build-frontend"

# ── 7. 安装 pi（默认：本 fork 的 Release 构建）────────────────────────────────
PI_BIN=""
if [[ "${PI_SOURCE}" == "release" ]]; then
  PI_PREFIX="${PI_PREFIX:-${ROOT_DIR}/pi}"
  log "安装 pi（fork 构建 ${PI_RELEASE_REPO}@${PI_RELEASE_TAG} → ${PI_PREFIX}）"

  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] 下载 %s@%s 的 tgz 资产，然后 npm install -g --prefix %s <tgz...>\n' \
      "${PI_RELEASE_REPO}" "${PI_RELEASE_TAG}" "${PI_PREFIX}"
  else
    TMP_TGZ="$(mktemp -d)"
    trap 'rm -rf "${TMP_TGZ}"' EXIT

    # 资产清单来自 Release API；API 不可用时回退到已知的 10 个包名
    ASSET_URLS="$(PI_RELEASE_REPO="${PI_RELEASE_REPO}" PI_RELEASE_TAG="${PI_RELEASE_TAG}" node -e '
      const repo = process.env.PI_RELEASE_REPO
      const tag = process.env.PI_RELEASE_TAG
      const version = tag.replace(/^v/, "")
      const names = ["chord","pi-ai","pi-agent-core","pi-client","pi-coding-agent","pi-protocol","pi-server","pi-session-backend-sqlite-node","pi-telemetry","pi-tui"]
      const fallback = names.map((n) => `https://github.com/${repo}/releases/download/${tag}/earendil-works-${n}-${version}.tgz`)
      fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: { "user-agent": "pi-standalone-installer" } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => console.log(j.assets.map((a) => a.browser_download_url).join("\n")))
        .catch(() => console.log(fallback.join("\n")))
    ')"
    [[ -n "${ASSET_URLS}" ]] || die "无法获取 ${PI_RELEASE_REPO}@${PI_RELEASE_TAG} 的资产列表"

    while IFS= read -r url; do
      [[ -n "${url}" ]] || continue
      log "  下载 $(basename "${url}")"
      curl -fsSL -o "${TMP_TGZ}/$(basename "${url}")" "${url}" || die "下载失败: ${url}"
    done <<< "${ASSET_URLS}"

    log "npm install -g --prefix ${PI_PREFIX}（10 个 tgz 一起装）"
    mkdir -p "${PI_PREFIX}"
    npm install -g --prefix "${PI_PREFIX}" "${TMP_TGZ}"/*.tgz --no-audit --no-fund \
      || die "安装 fork 版 pi 失败（检查 node/npm 版本与网络）"
  fi

  PI_BIN="${PI_PREFIX}/bin/pi"
  if [[ "${DRY_RUN}" != "1" ]]; then
    if [[ -x "${PI_BIN}" ]]; then
      log "pi 版本：$("${PI_BIN}" --version 2>/dev/null || echo unknown) （${PI_BIN}）"
    else
      warn "未找到 ${PI_BIN}，dashboard 会退回仓库内自带的 pi"
      PI_BIN=""
    fi
  fi
elif [[ "${PI_SOURCE}" == "official" ]]; then
  PI_SPEC="@earendil-works/pi-coding-agent${INSTALL_PI_VERSION:+@${INSTALL_PI_VERSION}}"
  log "全局安装官方 pi CLI: ${PI_SPEC}"
  run npm install -g "${PI_SPEC}" --no-audit --no-fund || \
    warn "全局安装失败（可能需要 sudo 或配置 npm prefix）；dashboard 会用仓库内的 node_modules/.bin/pi"
  warn "官方版缺少 executeTool / extension_ui 等扩展 API：run_code、live session、子 Agent 全屏会降级或不可用"
else
  log "按 --skip-pi 跳过 pi 安装（请自备 0.85.1-tsien.1 或更新版本）"
fi

# 让 dashboard 启动的每个 pi 进程都用这个 pi：写进 dashboard 的环境文件（backend 启动时自动加载）
if [[ -n "${PI_BIN}" ]]; then
  ENV_FILE="${AGENT_DIR}/dashboard.env"
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] 写 %s（PI_SCRIPT=%s）\n' "${ENV_FILE}" "${PI_BIN}"
  else
    run mkdir -p "${AGENT_DIR}"
    if [[ -f "${ENV_FILE}" ]] && grep -q '^PI_SCRIPT=' "${ENV_FILE}"; then
      warn "${ENV_FILE} 已设置 PI_SCRIPT，保持不变（如需切换请手动编辑）"
    else
      printf 'PI_SCRIPT=%s\n' "${PI_BIN}" >> "${ENV_FILE}"
      log "已写入 ${ENV_FILE} → PI_SCRIPT=${PI_BIN}"
    fi
  fi
fi

# ── 8. 可选：systemd 服务 ─────────────────────────────────────────────────────
if [[ "${DO_SERVICE}" == "1" ]]; then
  command -v systemctl >/dev/null || die "--service 需要 systemd"
  sudo -n true 2>/dev/null || warn "systemd 安装需要 sudo 权限，稍后可能提示输入密码"
  UNIT_NAME="pi-dashboard.service"
  NODE_BIN="$(command -v node)"
  TSX_BIN="${DASHBOARD_DIR}/node_modules/.bin/tsx"
  [[ -x "${TSX_BIN}" ]] || die "缺少 ${TSX_BIN}，请先完成 npm install"
  log "写入 /etc/systemd/system/${UNIT_NAME}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] sudo tee /etc/systemd/system/%s\n' "${UNIT_NAME}"
  else
    sudo tee "/etc/systemd/system/${UNIT_NAME}" >/dev/null <<EOF
[Unit]
Description=pi-dashboard server
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${DASHBOARD_DIR}
Environment=HOME=${HOME}
Environment=PATH=$(dirname "${NODE_BIN}"):/usr/local/bin:/usr/bin:/bin
Environment=PI_DASH_PORT=${PORT}
Environment=PI_CODING_AGENT_DIR=${AGENT_DIR}
ExecStart=${NODE_BIN} --no-wasm-tier-up --liftoff-only --wasm-lazy-compilation --import tsx backend/server.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now "${UNIT_NAME}"
    log "服务已启动：sudo systemctl status ${UNIT_NAME}"
  fi
fi

# ── 9. 可选：后台启动 ─────────────────────────────────────────────────────────
if [[ "${DO_START}" == "1" && "${DO_SERVICE}" != "1" ]]; then
  LOG_FILE="${DASHBOARD_DIR}/standalone-server.log"
  log "后台启动 dashboard（日志: ${LOG_FILE}）"
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] cd %s && PI_DASH_PORT=%s nohup ./run.sh >> %s 2>&1 &\n' "${DASHBOARD_DIR}" "${PORT}" "${LOG_FILE}"
  else
    ( cd "${DASHBOARD_DIR}" && PI_DASH_PORT="${PORT}" nohup ./run.sh >>"${LOG_FILE}" 2>&1 & echo $! >"${DASHBOARD_DIR}/.standalone-run.pid" )
    log "pid $(cat "${DASHBOARD_DIR}/.standalone-run.pid")"
  fi
fi

# ── 10. 后续步骤 ──────────────────────────────────────────────────────────────
cat <<EOF

── 完成 ─────────────────────────────────────────────────────────────
下一步：
  1) 配置模型凭证（三选一）：
     - 交互式登录： pi  然后执行 /login
     - 或写进环境文件 ${AGENT_DIR}/dashboard.env（dashboard 启动时自动加载，
       并会传给每个 pi 子进程），例如：
         ANTHROPIC_API_KEY=sk-...
         DASHSCOPE_API_KEY=sk-...
     - 或导出到启动 dashboard 的那个 shell 环境
  2) 启动服务：
     cd ${DASHBOARD_DIR} && PI_DASH_PORT=${PORT} ./run.sh
     浏览器打开 http://localhost:${PORT}
  3) 如果 Pi 正在运行，执行 /reload 或重启，使扩展配置生效。
  4) 远程访问（Tailscale / SSH 隧道 / nginx 反代）见 docs/remote-access-deployment.md。
EOF