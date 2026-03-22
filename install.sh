#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3333}"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="cc-dashboard"
SETTINGS_FILE="$HOME/.claude/settings.json"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { printf "${GREEN}[*]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
error() { printf "${RED}[x]${NC} %s\n" "$1"; exit 1; }

# --- 1. Bun check ---
info "Checking Bun installation..."
if ! command -v bun &>/dev/null; then
  warn "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
info "Bun $(bun --version) found"

# --- 2. jq check ---
if ! command -v jq &>/dev/null; then
  error "jq is required but not installed. Install it first: sudo apt install jq"
fi

# --- 3. Port validation ---
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  error "Invalid port: $PORT (must be 1024-65535)"
fi

if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  warn "Port $PORT is already in use"
  read -rp "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

info "Using port $PORT"

# --- 4. Hook setup ---
info "Configuring Claude Code hooks..."

mkdir -p "$(dirname "$SETTINGS_FILE")"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{}' > "$SETTINGS_FILE"
fi

# Validate existing JSON
if ! jq empty "$SETTINGS_FILE" 2>/dev/null; then
  error "$SETTINGS_FILE is not valid JSON. Fix it manually first."
fi

BASE_URL="http://localhost:${PORT}/notify"

# Build hook entries
HOOK_PROMPT=$(jq -n --arg url "${BASE_URL}?event=prompt" \
  '[{"hooks": [{"type": "http", "url": $url, "timeout": 2}]}]')
HOOK_PERMISSION=$(jq -n --arg url "${BASE_URL}?event=permission" \
  '[{"hooks": [{"type": "http", "url": $url, "timeout": 2}]}]')
HOOK_STOP=$(jq -n --arg url "${BASE_URL}?event=stop" \
  '[{"hooks": [{"type": "http", "url": $url, "timeout": 2}]}]')

# Remove existing cc-dashboard hooks (matching our URL pattern), then add new ones
TEMP_FILE=$(mktemp)
jq --argjson prompt "$HOOK_PROMPT" \
   --argjson permission "$HOOK_PERMISSION" \
   --argjson stop "$HOOK_STOP" \
   --arg base_url "localhost:${PORT}/notify" '
  # Remove any existing hooks pointing to our notify endpoint (any port)
  .hooks //= {} |
  .hooks.UserPromptSubmit = (
    [(.hooks.UserPromptSubmit // [] | .[] | select(.hooks[0].url | test("localhost:[0-9]+/notify") | not))] + $prompt
  ) |
  .hooks.PermissionRequest = (
    [(.hooks.PermissionRequest // [] | .[] | select(.hooks[0].url | test("localhost:[0-9]+/notify") | not))] + $permission
  ) |
  .hooks.Stop = (
    [(.hooks.Stop // [] | .[] | select(.hooks[0].url | test("localhost:[0-9]+/notify") | not))] + $stop
  )
' "$SETTINGS_FILE" > "$TEMP_FILE"

# Verify the generated JSON is valid before overwriting
if jq empty "$TEMP_FILE" 2>/dev/null; then
  mv "$TEMP_FILE" "$SETTINGS_FILE"
  info "Hooks configured for port $PORT"
else
  rm -f "$TEMP_FILE"
  error "Hook injection produced invalid JSON. Settings file unchanged."
fi

# --- 5. systemd user service ---
info "Setting up systemd user service..."

SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

cat > "${SERVICE_DIR}/${SERVICE_NAME}.service" << EOF
[Unit]
Description=CC Dashboard - Claude Code Session Monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=PORT=${PORT}
ExecStart=$(command -v bun) run server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" 2>/dev/null
systemctl --user restart "$SERVICE_NAME"

# --- 6. Health check ---
info "Waiting for server to start..."
for i in $(seq 1 10); do
  if curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1; then
    info "Server is running at http://localhost:${PORT}"
    echo ""
    printf "${GREEN}Installation complete!${NC}\n"
    echo ""
    echo "  Dashboard:  http://localhost:${PORT}"
    echo "  Service:    systemctl --user status ${SERVICE_NAME}"
    echo "  Logs:       journalctl --user -u ${SERVICE_NAME} -f"
    echo "  Uninstall:  ${INSTALL_DIR}/uninstall.sh"
    echo ""
    exit 0
  fi
  sleep 1
done

warn "Server started but health check timed out. Check logs:"
echo "  journalctl --user -u ${SERVICE_NAME} -f"
