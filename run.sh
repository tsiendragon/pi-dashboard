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

# WASM blast-radius flags (SDK-migration slice 8): launch-time V8 isolate flags
# that reduce the chance of an uncatchable WASM-OOM / tier-up abort taking down
# the in-process agent + the whole server. They CANNOT be applied to a live
# agent, so the server itself must run under them. Server logs the effective V8
# flags on boot for verification.
exec ./node_modules/.bin/tsx --no-wasm-tier-up --liftoff-only --wasm-lazy-compilation backend/server.ts
