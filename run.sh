#!/usr/bin/env bash
set -euo pipefail

# Direct server launch — builds the frontend, then starts the backend.
# For restarts, use: ./restart.sh or sudo systemctl restart pi-dashboard
cd "$(dirname "$0")"

echo "[pi-dashboard] Building frontend ($(date))"
npm --prefix frontend run build

echo "[pi-dashboard] Frontend build complete"

# bedrock-mantle proxy capture: durable log + empty-completion variant dumps.
# Spawned pi slots inherit these via pi-manager's `...process.env`. The
# no_terminal / non_sse dumps fire at default log level (no debug needed).
export BEDROCK_MANTLE_LOG_FILE="${BEDROCK_MANTLE_LOG_FILE:-$HOME/.pi/logs/bedrock-mantle.log}"
export BEDROCK_MANTLE_EMPTY_DUMP_DIR="${BEDROCK_MANTLE_EMPTY_DUMP_DIR:-$HOME/.pi/logs/empty-dumps}"

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
