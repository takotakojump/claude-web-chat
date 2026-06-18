#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$APP_DIR/logs"
PID_FILE="$APP_DIR/claude-web-chat.pid"
CONFIG_FILE="$APP_DIR/config.json"
EXAMPLE_CONFIG="$APP_DIR/config.example.json"
HOST_VALUE="${HOST:-}"
PORT_VALUE="${PORT:-}"
MODE="start"
FOREGROUND=0

usage() {
  cat <<'USAGE'
Usage: ./install-linux.sh [options]

Installs runtime dependencies, creates config.json when missing, and starts
Claude Web Chat on Linux.

Options:
  --host HOST        Override config.json server.host for this launch
  --port PORT        Override config.json server.port for this launch
  --foreground       Run in the foreground instead of using nohup
  --restart          Stop an existing background process, then start it
  --stop             Stop the background process recorded in claude-web-chat.pid
  --status           Print process status
  -h, --help         Show this help

Examples:
  ./install-linux.sh
  ./install-linux.sh --host 0.0.0.0 --port 3652
  ./install-linux.sh --restart

Without --host/--port, config.json controls the bind address and port.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST_VALUE="${2:-}"
      shift 2
      ;;
    --port)
      PORT_VALUE="${2:-}"
      shift 2
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    --restart)
      MODE="restart"
      shift
      ;;
    --stop)
      MODE="stop"
      shift
      ;;
    --status)
      MODE="status"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

log() {
  printf '[claude-web-chat] %s\n' "$*"
}

config_value() {
  local key="$1"
  local fallback="$2"
  if command -v node >/dev/null 2>&1 && [[ -f "$CONFIG_FILE" ]]; then
    node -e '
const fs = require("fs");
const file = process.argv[1];
const key = process.argv[2];
const fallback = process.argv[3] || "";
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const value = key.split(".").reduce((obj, part) => {
  if (!obj || typeof obj !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(obj, part) ? obj[part] : undefined;
}, config);
process.stdout.write(value === undefined || value === null || String(value) === "" ? fallback : String(value));
' "$CONFIG_FILE" "$key" "$fallback"
  else
    printf '%s' "$fallback"
  fi
}

display_url() {
  local host port
  host="${HOST_VALUE:-$(config_value server.host 127.0.0.1)}"
  port="${PORT_VALUE:-$(config_value server.port 3652)}"
  printf 'http://%s:%s' "$host" "$port"
}


listen_port() {
  printf '%s' "${PORT_VALUE:-$(config_value server.port 3652)}"
}

find_port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$port/tcp" 2>/dev/null | tr ' ' '\n' || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v port=":$port" '$4 ~ port"$" {print $7}' | cut -d/ -f1 || true
  fi
}

process_belongs_to_app() {
  local pid="$1"
  local cwd=""
  local cmdline=""
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$cwd" == "$APP_DIR" ]]; then
    return 0
  fi
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmdline" == *"$APP_DIR"* && "$cmdline" == *"server.js"* ]]
}

stop_orphan_listeners() {
  local port pid
  port="$(listen_port)"
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if [[ "$pid" == "$$" ]]; then
      continue
    fi
    if process_belongs_to_app "$pid"; then
      log "Stopping orphan listener PID $pid on port $port"
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
  done < <(find_port_pids "$port" | sort -u)
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This step needs root privileges. Install sudo or run as root: $*" >&2
    return 1
  fi
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

install_node_with_package_manager() {
  log "Node.js 18+ was not found. Trying to install nodejs/npm with the system package manager."
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add --no-cache nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm nodejs npm
  else
    echo "No supported package manager found. Please install Node.js 18+ and npm manually." >&2
    exit 1
  fi
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 18 ]]; then
    install_node_with_package_manager
  fi

  if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 18 ]]; then
    echo "Node.js 18+ is required, but the installed version is: $(node -v 2>/dev/null || echo missing)." >&2
    echo "Install a current Node.js LTS release, then rerun this script." >&2
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required but was not found." >&2
    exit 1
  fi
}

ensure_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    if [[ ! -f "$EXAMPLE_CONFIG" ]]; then
      echo "Missing config template: $EXAMPLE_CONFIG" >&2
      exit 1
    fi
    cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
    log "Created config.json from config.example.json. Edit it to add claude.apiKey and claude.baseUrl."
  fi
}

install_dependencies() {
  cd "$APP_DIR"
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

stop_app() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    log "Stopping process $pid"
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        log "Stopped"
        return 0
      fi
      sleep 0.2
    done
    log "Process did not stop gracefully; sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  else
    rm -f "$PID_FILE"
    log "Not running"
  fi
  stop_orphan_listeners
}

status_app() {
  if is_running; then
    log "Running with PID $(cat "$PID_FILE")"
    log "URL: $(display_url)"
  else
    log "Not running"
  fi
}

start_app() {
  cd "$APP_DIR"
  mkdir -p "$LOG_DIR"
  if is_running; then
    log "Already running with PID $(cat "$PID_FILE")"
    log "URL: $(display_url)"
    exit 0
  fi
  stop_orphan_listeners

  if [[ -n "$HOST_VALUE" ]]; then
    export HOST="$HOST_VALUE"
  fi
  if [[ -n "$PORT_VALUE" ]]; then
    export PORT="$PORT_VALUE"
  fi

  if [[ "$FOREGROUND" -eq 1 ]]; then
    log "Starting in foreground at $(display_url)"
    exec node src/server.js
  fi

  log "Starting in background at $(display_url)"
  nohup node src/server.js >"$LOG_DIR/app.log" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1

  if is_running; then
    log "Started with PID $(cat "$PID_FILE")"
    log "Log file: $LOG_DIR/app.log"
  else
    echo "Failed to start. Last log lines:" >&2
    tail -n 60 "$LOG_DIR/app.log" >&2 || true
    exit 1
  fi
}

case "$MODE" in
  stop)
    stop_app
    exit 0
    ;;
  status)
    status_app
    exit 0
    ;;
  restart)
    stop_app
    ;;
esac

ensure_node
ensure_config
install_dependencies
start_app
