#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="cc-dashboard"
SETTINGS_FILE="$HOME/.claude/settings.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { printf "${GREEN}[*]${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$1"; }

# --- 1. Stop and remove service ---
if systemctl --user is-active "$SERVICE_NAME" &>/dev/null; then
  info "Stopping service..."
  systemctl --user stop "$SERVICE_NAME"
fi

if systemctl --user is-enabled "$SERVICE_NAME" &>/dev/null; then
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null
fi

SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
if [ -f "$SERVICE_FILE" ]; then
  rm "$SERVICE_FILE"
  systemctl --user daemon-reload
  info "Service removed"
fi

# --- 2. Remove hooks ---
if [ -f "$SETTINGS_FILE" ] && command -v jq &>/dev/null; then
  TEMP_FILE=$(mktemp)
  jq '
    .hooks //= {} |
    .hooks.UserPromptSubmit = [.hooks.UserPromptSubmit // [] | .[] | select(.hooks[0].url | test("localhost:[0-9]+/notify") | not)] |
    .hooks.PermissionRequest = [.hooks.PermissionRequest // [] | .[] | select(.hooks[0].url | test("localhost:[0-9]+/notify") | not)] |
    .hooks.Stop = [.hooks.Stop // [] | .[] | select(.hooks[0].url | test("localhost:[0-9]+/notify") | not)] |
    # Clean up empty arrays
    if .hooks.UserPromptSubmit == [] then del(.hooks.UserPromptSubmit) else . end |
    if .hooks.PermissionRequest == [] then del(.hooks.PermissionRequest) else . end |
    if .hooks.Stop == [] then del(.hooks.Stop) else . end |
    if .hooks == {} then del(.hooks) else . end
  ' "$SETTINGS_FILE" > "$TEMP_FILE"

  if jq empty "$TEMP_FILE" 2>/dev/null; then
    mv "$TEMP_FILE" "$SETTINGS_FILE"
    info "Hooks removed from settings.json"
  else
    rm -f "$TEMP_FILE"
    warn "Could not clean hooks. Remove manually from $SETTINGS_FILE"
  fi
else
  warn "jq not found or settings.json missing. Remove hooks manually."
fi

echo ""
printf "${GREEN}Uninstall complete.${NC}\n"
echo "Project files were NOT deleted. Remove manually if needed:"
echo "  rm -rf $(cd "$(dirname "$0")" && pwd)"
