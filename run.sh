#!/usr/bin/env bash
set -euo pipefail

# Direct server launch — builds the frontend, then starts the backend.
# For restarts, use: ./restart.sh or sudo systemctl restart pi-dashboard
cd "$(dirname "$0")"

# Make user-local tools (gh, pimatrix, pi, ...) visible to this server and to
# every pi session / bash tool it spawns. The launch context is often a
# restricted PATH (e.g. /usr/local/bin:/usr/bin:/bin), which would otherwise
# hide $HOME/.local/bin.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# Type-check first: fail fast in seconds, instead of after the slower Vite build.
# The backend runs through tsx, which strips types without checking them, so the
# backend needs this gate here just as much as the frontend does.
echo "[pi-dashboard] Type-checking backend + frontend ($(date))"
npm run typecheck

echo "[pi-dashboard] Type check passed"

echo "[pi-dashboard] Building frontend ($(date))"
npm --prefix frontend run build

echo "[pi-dashboard] Frontend build complete"

# bedrock-mantle proxy capture: durable log + empty-completion variant dumps.
# Spawned pi slots inherit these via pi-manager's `...process.env`. The
# no_terminal / non_sse dumps fire at default log level (no debug needed).
export BEDROCK_MANTLE_LOG_FILE="${BEDROCK_MANTLE_LOG_FILE:-$HOME/.pi/logs/bedrock-mantle.log}"
export BEDROCK_MANTLE_EMPTY_DUMP_DIR="${BEDROCK_MANTLE_EMPTY_DUMP_DIR:-$HOME/.pi/logs/empty-dumps}"

# pi trajectory recorder (pitrace): 全量 payload 体积大，优先落到 HDD。
# 仅当 HDD 真正挂载时才指向它——/run/media 未挂载时根目录是 tmpfs，写进去会吃内存。
# 未挂载则不设置，recorder 回退到默认 SSD 路径 ~/.pi/agent/pi-traces。
# 旧 trace 由 ~/.local/bin/pi-trace-clean.py (cron) 按保留期 + 容量上限清理。
PI_TRACE_HDD_ROOT="/run/media/tsien/Back"
if mountpoint -q "$PI_TRACE_HDD_ROOT"; then
  export PI_TRACE_DIR="${PI_TRACE_DIR:-$PI_TRACE_HDD_ROOT/pi-traces}"
fi

# --- Lark (Feishu) gateway -------------------------------------------------
# Background companion to the server: bridges Lark chats to live-sessions
# (inbound message -> session input; session output -> Lark chat).
# Skipped when no account is configured, or when PI_LARK_GATEWAY=off.
# It shares the server's process group, so the usual Ctrl-C / stop signal
# takes both down together.
LARK_RUN_DIR="$HOME/.pi/agent/run/pi-dashboard"
if [[ "${PI_LARK_GATEWAY:-on}" != "off" && -f "$LARK_RUN_DIR/lark-accounts.json" ]]; then
  LARK_GW_LOG="${LARK_GW_LOG:-$HOME/.pi/logs/lark-gateway.log}"
  # Take over from a previous instance so the single-instance lock is free.
  if [[ -f "$LARK_RUN_DIR/lark-gateway.lock" ]]; then
    OLD_PID="$(cat "$LARK_RUN_DIR/lark-gateway.lock" 2>/dev/null || true)"
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[pi-dashboard] Stopping previous Lark gateway (pid $OLD_PID)"
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
  fi
  mkdir -p "$(dirname "$LARK_GW_LOG")"
  echo "[pi-dashboard] Starting Lark gateway (log: $LARK_GW_LOG)"
  ./node_modules/.bin/tsx channels/lark/src/index.ts >>"$LARK_GW_LOG" 2>&1 &
  echo "[pi-dashboard] Lark gateway pid $!"
else
  echo "[pi-dashboard] Lark gateway skipped (no account config or PI_LARK_GATEWAY=off)"
fi

# WASM blast-radius flags (SDK-migration slice 8): launch-time V8 isolate flags
# that reduce the chance of an uncatchable WASM-OOM / tier-up abort taking down
# the in-process agent + the whole server. They CANNOT be applied to a live
# agent, so the server itself must run under them. Server logs the effective V8
# flags on boot for verification.
exec ./node_modules/.bin/tsx --no-wasm-tier-up --liftoff-only --wasm-lazy-compilation backend/server.ts
