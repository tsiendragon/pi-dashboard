#!/usr/bin/env bash
# Lark gateway watchdog. Run from cron every minute:
#
#   * * * * * /path/to/pi-dashboard/scripts/lark-watchdog.sh
#
# Keeps the Lark gateway alive on hosts with no systemd (containers): starts it
# when it is not running, and checks the resources whose exhaustion silently
# killed it before (inotify instances, leaked session-bus daemons).
#
# Does nothing when no Lark account is configured or PI_LARK_GATEWAY=off,
# and never touches the dashboard itself (the gateway reconnects to it).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$HOME/.pi/agent/run/pi-dashboard"
LOCK="$RUN_DIR/lark-gateway.lock"
LOG="${LARK_GW_LOG:-$HOME/.pi/logs/lark-gateway.log}"
WD_LOG="${LARK_WATCHDOG_LOG:-$HOME/.pi/logs/lark-watchdog.log}"
mkdir -p "$(dirname "$WD_LOG")"
log() { echo "$(date '+%F %T') $*" >>"$WD_LOG"; }

# cron has a minimal PATH: add the usual node install locations (newest first).
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
for candidate in "$HOME"/opt/node-*/bin "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
  [[ -x "$candidate/node" ]] && PATH="$candidate:$PATH"
done
command -v node >/dev/null || { log "ERROR no node on PATH"; exit 1; }
# No session bus here: keep any child CLI from autolaunching (and leaking) one.
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-disabled:}"

# One watchdog at a time (a slow start must not be raced by the next tick).
mkdir -p "$RUN_DIR"
exec 9>>"$RUN_DIR/lark-watchdog.flock" || exit 0
flock -n 9 || exit 0

[[ "${PI_LARK_GATEWAY:-on}" == "off" ]] && exit 0
[[ -f "$RUN_DIR/lark-accounts.json" ]] || exit 0

# --- resource guard ----------------------------------------------------------
# Orphaned session buses (parent gone, PPID=1) each hold an inotify instance;
# 8k of them once starved fs.watch and took the gateway down.
orphans=$(ps -u "$(id -u)" -o pid=,ppid=,args= | awk '$2==1 && /dbus-daemon .*--session/{print $1}')
if [[ -n "$orphans" ]]; then
  count=$(wc -w <<<"$orphans")
  if (( count > 20 )); then
    log "reaping $count orphaned dbus-daemon session buses"
    kill $orphans 2>/dev/null || true
  fi
fi
limit=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 0)
if (( limit > 0 )); then
  used=$(find /proc/[0-9]*/fd -lname 'anon_inode:inotify' -user "$(id -u)" 2>/dev/null | wc -l)
  (( used * 10 >= limit * 9 )) && log "WARN inotify instances ${used}/${limit} (>=90%)"
fi

# --- liveness ----------------------------------------------------------------
# A gateway is a node/tsx process whose argv names the entry file. Match on argv
# entries (not `pgrep -f`), which would also match this shell or an editor.
gateway_pids() {
  local dir cmd
  for dir in /proc/[0-9]*; do
    [[ -O "$dir" ]] || continue
    cmd=$(tr '\0' '\n' <"$dir/cmdline" 2>/dev/null) || continue
    grep -qx 'channels/lark/src/index.ts' <<<"$cmd" || continue
    grep -qE '(^|/)(node|tsx)$' <<<"$cmd" && echo "${dir#/proc/}"
  done
}
if [[ -n "$(gateway_pids)" ]]; then
  exit 0
fi
pid="$(cat "$LOCK" 2>/dev/null || true)"

log "gateway not running (lock pid: ${pid:-none}); starting"
cd "$ROOT" || exit 1
setsid nohup ./node_modules/.bin/tsx channels/lark/src/index.ts >>"$LOG" 2>&1 </dev/null &
sleep 8
if [[ -n "$(gateway_pids)" ]]; then
  log "gateway started (pid $(cat "$LOCK" 2>/dev/null || echo '?'))"
else
  log "ERROR gateway exited right after start; last log lines:"
  tail -n 5 "$LOG" | sed 's/^/    /' >>"$WD_LOG"
fi
