#!/usr/bin/env bash
#
# stack-update.sh — 每台机器各自更新 pi / pi-tsien-extension / pi-dashboard。
#
# 设计要点（详见 guide/stack-update.md）：
#   - 三层各自只有一个 Git 源，本脚本只做「消费端」更新，不修改已安装副本。
#   - 不做全局版本锁定：每台机器用自己的清单（默认 ~/.pi/agent/stack.json）决定
#     「装哪些扩展、跟哪个版本」，机器之间可以完全不同。
#   - 每台机器各装哪些扩展由 extension 清单（extensions.config.json）决定；本脚本
#     只在清单不存在时创建，绝不覆盖已有的每机选择。
#
# 用法：
#   bash scripts/stack-update.sh --check            # 只报告漂移，不改动
#   bash scripts/stack-update.sh --apply            # 执行更新并写回 lastApplied
#   bash scripts/stack-update.sh --apply --only extensions
#   bash scripts/stack-update.sh --config ~/.pi/agent/stack.json
#   bash scripts/stack-update.sh --help
#
# 环境变量：
#   PI_DASH_AGENT_DIR / PI_CODING_AGENT_DIR  覆盖 agent 目录（默认 ~/.pi/agent）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODE="check"
ONLY=""
DO_BACKUP=1
AGENT_DIR_ARG=""
CONFIG_ARG=""
AGENT_DIR=""
CONFIG=""
EXAMPLE="${SCRIPT_DIR}/stack.json.example"

log()  { printf '\033[1;34m[stack]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[stack]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[stack]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   MODE="check"; shift ;;
    --apply)   MODE="apply"; shift ;;
    --only)    ONLY="$2"; shift 2 ;;
    --config)  CONFIG_ARG="$2"; shift 2 ;;
    --agent-dir) AGENT_DIR_ARG="$2"; shift 2 ;;
    --no-backup) DO_BACKUP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

AGENT_DIR="${AGENT_DIR_ARG:-${PI_DASH_AGENT_DIR:-${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}}}"
CONFIG="${CONFIG_ARG:-${AGENT_DIR}/stack.json}"

expand_path() { printf '%s' "${1/#\~/${HOME}}"; }

[[ "$MODE" == "check" || "$MODE" == "apply" ]] || die "内部错误：MODE=$MODE"

# ── 读取本机清单 ─────────────────────────────────────────────────────────────
if [[ ! -f "${CONFIG}" ]]; then
  warn "未找到本机清单：${CONFIG}"
  [[ -f "${EXAMPLE}" ]] && log "可复制模板后按需修改：cp ${EXAMPLE} ${CONFIG}"
  die "缺少 stack.json"
fi
CONFIG="$(expand_path "${CONFIG}")"

cfg() {
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let v = c;
    for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
    process.stdout.write(v == null ? "" : String(v));
  ' "${CONFIG}" "$1"
}

cfg_or() { local v; v="$(cfg "$1")"; printf '%s' "${v:-$2}"; }

ROOT="$(expand_path "$(cfg_or root "${HOME}/pi-stack")")"
PI_REPO="$(cfg_or pi.repo "tsiendragon/pi")"
PI_POLICY="$(cfg_or pi.policy "latest-tag")"
PI_REF="$(cfg pi.ref)"
PI_PREFIX="$(expand_path "$(cfg_or pi.prefix "${ROOT}/pi")")"

EXT_POLICY="$(cfg_or extensions.policy "latest-tag")"
EXT_REF="$(cfg extensions.ref)"
EXT_DIR="$(expand_path "$(cfg_or extensions.dir "${ROOT}/pi-tsien-extension")")"
EXT_REPO="$(cfg_or extensions.repo "https://github.com/tsiendragon/pi-tsien-extension.git")"
EXT_CONFIG="$(expand_path "$(cfg_or extensions.config "${AGENT_DIR}/extensions.config.json")")"

DASH_POLICY="$(cfg_or dashboard.policy "latest-tag")"
DASH_REF="$(cfg dashboard.ref)"
DASH_DIR="$(expand_path "$(cfg_or dashboard.dir "${DASHBOARD_DIR}")")"
DASH_REPO="$(cfg dashboard.repo)"
if [[ -z "${DASH_REPO}" && -d "${DASH_DIR}/.git" ]]; then
  DASH_REPO="$(git -C "${DASH_DIR}" remote get-url origin 2>/dev/null || true)"
fi

LAST_PI="$(cfg lastApplied.pi)"
LAST_EXT="$(cfg lastApplied.extensions)"
LAST_DASH="$(cfg lastApplied.dashboard)"

layer_enabled() { [[ -z "${ONLY}" || "${ONLY}" == "$1" ]]; }

# ── 版本解析 ─────────────────────────────────────────────────────────────────
# 远端最新 tag（形如 v1.2.3 / v0.85.1-tsien.1），sort -V 排序取最大。
latest_tag() {
  local repo="$1" tags
  tags="$(git ls-remote --tags --refs "${repo}" 2>/dev/null | awk -F/ '{print $NF}' | grep -E '^v[0-9]' || true)"
  [[ -n "${tags}" ]] || return 1
  printf '%s\n' "${tags}" | sort -V | tail -1
}

resolve_ref() {
  # $1=policy $2=repo $3=ref
  case "$1" in
    skip)       printf '' ;;
    pinned)     [[ -n "$3" ]] || die "policy=pinned 但 ref 为空（${2}）"; printf '%s' "$3" ;;
    branch)     [[ -n "$3" ]] || die "policy=branch 但 ref 为空（${2}）"; printf '%s' "$3" ;;
    latest-tag) latest_tag "$2" || die "无法获取 ${2} 的最新 tag（网络或仓库问题）" ;;
    *)          die "未知 policy：$1（应为 latest-tag/pinned/branch/skip）" ;;
  esac
}

local_ref() {
  # 已 checkout 的本地版本标识（tag 优先，否则短 commit）
  local dir="$1"
  [[ -d "${dir}/.git" ]] || { printf ''; return 0; }
  git -C "${dir}" describe --tags --always 2>/dev/null || printf ''
}

# ── 更新动作 ─────────────────────────────────────────────────────────────────
git_track() {
  # $1=dir $2=policy $3=ref  —— fetch + checkout/pull
  local dir="$1" policy="$2" ref="$3"
  [[ -d "${dir}/.git" ]] || die "目录不是 git 仓库：${dir}"
  git -C "${dir}" fetch --tags --prune --quiet
  if [[ "${policy}" == "branch" ]]; then
    git -C "${dir}" checkout --quiet "${ref}"
    git -C "${dir}" pull --ff-only --quiet
  else
    git -C "${dir}" checkout --quiet "${ref}"
  fi
}

npm_ci() {
  local dir="$1"
  if [[ -f "${dir}/package-lock.json" ]]; then
    ( cd "${dir}" && npm ci --no-audit --no-fund )
  else
    ( cd "${dir}" && npm install --no-audit --no-fund )
  fi
}

update_dashboard() {
  local target="$1"
  log "dashboard ← ${target}  (${DASH_DIR})"
  git_track "${DASH_DIR}" "${DASH_POLICY}" "${target}"
  npm_ci "${DASH_DIR}"
  ( cd "${DASH_DIR}" && npm run build-frontend )
}

update_extensions() {
  local target="$1"
  log "extensions ← ${target}  (${EXT_DIR})"
  git_track "${EXT_DIR}" "${EXT_POLICY}" "${target}"
  npm_ci "${EXT_DIR}"

  # 每台机器的扩展选择是私有的：只在缺失时创建，绝不覆盖已有选择。
  if [[ ! -f "${EXT_CONFIG}" ]]; then
    local seed="${EXT_DIR}/config/extensions.standalone.json"
    [[ -f "${seed}" ]] || die "扩展清单缺失，且找不到种子配置 ${seed}"
    mkdir -p "$(dirname "${EXT_CONFIG}")"
    cp "${seed}" "${EXT_CONFIG}"
    log "已按通用集合创建本机扩展清单：${EXT_CONFIG}（之后可自行增删包）"
  else
    log "沿用已有本机扩展清单：${EXT_CONFIG}（不覆盖）"
  fi

  node "${EXT_DIR}/scripts/pi-extension-sync.mjs" \
    --config "${EXT_CONFIG}" --agent-dir "${AGENT_DIR}" --apply \
    || die "扩展同步失败（${EXT_DIR}/scripts/pi-extension-sync.mjs）"
}

update_pi() {
  local target="$1"
  log "pi ← ${target}  (${PI_PREFIX})"
  # 复用现成安装器，只装 pi；不动扩展清单、不装服务。
  bash "${DASHBOARD_DIR}/scripts/install-standalone.sh" -y \
    --pi-release "${PI_REPO}@${target}" \
    --pi-prefix "${PI_PREFIX}" \
    --dir "${ROOT}" \
    --dashboard-dir "${DASH_DIR}" \
    --agent-dir "${AGENT_DIR}" \
    --skip-extension-sync
}

# ── 兼容性契约：同一台机内 pi 与扩展必须互相兼容 ──────────────────────────────
compat_check() {
  local ext_pkg="${EXT_DIR}/package.json"
  [[ -f "${ext_pkg}" ]] || return 0
  local range
  range="$(node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write((j.peerDependencies || {})["@earendil-works/pi-coding-agent"] || "");
    } catch { }
  ' "${ext_pkg}" 2>/dev/null || true)"
  [[ -n "${range}" ]] || return 0

  local pi_bin="${PI_PREFIX}/bin/pi" piver=""
  [[ -x "${pi_bin}" ]] && piver="$("${pi_bin}" --version 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "${piver}" ]] || { warn "未找到 pi（${pi_bin}），跳过兼容性校验；扩展要求：${range}"; return 0; }

  local verdict
  verdict="$(node -e '
    const [v, r] = process.argv.slice(1);
    try { process.stdout.write(require("semver").satisfies(v, r) ? "ok" : "bad"); }
    catch { process.stdout.write("unknown"); }
  ' "${piver}" "${range}" 2>/dev/null || printf 'unknown')"

  case "${verdict}" in
    ok)   log "兼容性 OK：pi ${piver} 满足扩展要求 ${range}" ;;
    bad)  warn "兼容性告警：pi ${piver} 不满足扩展要求 ${range}（可能降级或报错）" ;;
    *)    log "兼容性未自动判定：pi ${piver}，扩展要求 ${range}（缺 semver，人工确认）" ;;
  esac
}

# ── 备份 + 写回状态 ───────────────────────────────────────────────────────────
backup_once() {
  [[ "${DO_BACKUP}" == "1" ]] || return 0
  local stamp dir
  stamp="$(date +%Y%m%d-%H%M%S)"
  dir="$(dirname "${CONFIG}")/stack-backups/${stamp}"
  mkdir -p "${dir}"
  cp -f "${CONFIG}" "${dir}/stack.json" 2>/dev/null || true
  [[ -f "${EXT_CONFIG}" ]] && cp -f "${EXT_CONFIG}" "${dir}/extensions.config.json" 2>/dev/null || true
  log "已备份本机清单到 ${dir}"
}

set_last_applied() {
  ST_PI="$1" ST_EXT="$2" ST_DASH="$3" node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.lastApplied = {
      pi: process.env.ST_PI || c.lastApplied?.pi || "",
      extensions: process.env.ST_EXT || c.lastApplied?.extensions || "",
      dashboard: process.env.ST_DASH || c.lastApplied?.dashboard || "",
      at: new Date().toISOString(),
    };
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n");
    fs.renameSync(tmp, p);
  ' "${CONFIG}"
}

# ── 主流程 ───────────────────────────────────────────────────────────────────
TARGET_PI=""; TARGET_EXT=""; TARGET_DASH=""
layer_enabled pi         && TARGET_PI="$(resolve_ref "${PI_POLICY}"   "${PI_REPO}"   "${PI_REF}")"
layer_enabled extensions && TARGET_EXT="$(resolve_ref "${EXT_POLICY}" "${EXT_REPO}" "${EXT_REF}")"
layer_enabled dashboard  && TARGET_DASH="$(resolve_ref "${DASH_POLICY}" "${DASH_REPO:-${DASH_DIR}}" "${DASH_REF}")"

L_PI="$(local_ref "${PI_PREFIX}")";   [[ -n "${L_PI}" ]]   || L_PI="${LAST_PI}"
if [[ -z "${L_PI}" && -x "${PI_PREFIX}/bin/pi" ]]; then
  L_PI="v$("${PI_PREFIX}/bin/pi" --version 2>/dev/null | tr -d '[:space:]' || true)"
fi
L_EXT="$(local_ref "${EXT_DIR}")";    [[ -n "${L_EXT}" ]]  || L_EXT="${LAST_EXT}"
L_DASH="$(local_ref "${DASH_DIR}")";  [[ -n "${L_DASH}" ]] || L_DASH="${LAST_DASH}"

row() { # $1=name $2=local $3=target
  local state="OK"
  [[ -z "$3" ]] && state="SKIP"
  [[ -n "$3" && "$2" != "$3" ]] && state="UPDATE"
  printf '\033[1;34m[stack]\033[0m %-11s local=%-22s target=%-22s %s\n' "$1" "${2:-none}" "${3:-none}" "$state"
  [[ "$state" == "UPDATE" ]] && return 1 || return 0
}

log "本机清单 ${CONFIG}（mode=${MODE}${ONLY:+ only=${ONLY}}）"
DRIFT=0
row pi         "${L_PI}"   "${TARGET_PI}"   || DRIFT=1
row extensions "${L_EXT}"  "${TARGET_EXT}"  || DRIFT=1
row dashboard  "${L_DASH}" "${TARGET_DASH}" || DRIFT=1
compat_check

if [[ "$MODE" == "check" ]]; then
  if [[ "${DRIFT}" == "0" ]]; then log "已是最新，无需更新"; else log "存在可更新项：运行 --apply 执行"; fi
  exit 0
fi

backup_once

if [[ -n "${TARGET_DASH}" && "${L_DASH}" != "${TARGET_DASH}" ]]; then update_dashboard "${TARGET_DASH}"; else log "dashboard 已是最新，跳过"; fi
if [[ -n "${TARGET_EXT}" && "${L_EXT}" != "${TARGET_EXT}" ]]; then update_extensions "${TARGET_EXT}"; else log "extensions 已是最新，跳过"; fi
if [[ -n "${TARGET_PI}"  && "${L_PI}"  != "${TARGET_PI}"  ]]; then update_pi "${TARGET_PI}";             else log "pi 已是最新，跳过"; fi

set_last_applied "${TARGET_PI:-$L_PI}" "${TARGET_EXT:-$L_EXT}" "${TARGET_DASH:-$L_DASH}"
log "已写回 lastApplied → ${CONFIG}"
compat_check
log "更新完成；请按你的启动方式重启服务（例如 ./run.sh）"