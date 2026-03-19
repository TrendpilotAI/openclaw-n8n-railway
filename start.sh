#!/bin/bash
set -e

# --- Tailscale Setup ---
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  echo "[tailscale] Starting daemon..."
  tailscaled --tun=userspace-networking --socks5-server=localhost:1055 \
    --state=/data/tailscale/tailscaled.state &
  TAILSCALED_PID=$!

  # Wait for tailscaled to be ready
  for i in $(seq 1 30); do
    if tailscale status >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  tailscale up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --hostname="${TAILSCALE_HOSTNAME:-openclaw-railway}" \
    --accept-routes
  echo "[tailscale] Connected to tailnet"

  # Enable Tailscale Serve in the background once the gateway is up
  if [ "$TAILSCALE_SERVE" = "true" ]; then
    (
      echo "[tailscale] Waiting for gateway before enabling serve..."
      for i in $(seq 1 120); do
        if curl -sf http://127.0.0.1:18789/health > /dev/null 2>&1; then
          sleep 2
          tailscale serve --bg --https=443 http://127.0.0.1:18789 2>&1 && \
            echo "[tailscale] Serve enabled on tailnet" || \
            echo "[tailscale] Serve setup failed (check ACLs)"
          break
        fi
        sleep 2
      done
    ) &
  fi
else
  echo "[tailscale] No TAILSCALE_AUTHKEY set, skipping"
fi

# --- GitHub CLI Setup ---
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global url."https://oauth2:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  echo "[github] Credentials configured"
fi

# --- OpenClaw Hot Update ---
# Set OPENCLAW_UPDATE_REF to update OpenClaw at boot without rebuilding the Docker image.
# Supports: --stable, --beta, --canary, or any branch/tag/SHA.
if [ -n "$OPENCLAW_UPDATE_REF" ]; then
  echo "[update] Updating OpenClaw to: $OPENCLAW_UPDATE_REF"
  if \
    PNPM_IGNORE_SCRIPTS="${PNPM_IGNORE_SCRIPTS:-true}" \
    NPM_CONFIG_IGNORE_SCRIPTS="${NPM_CONFIG_IGNORE_SCRIPTS:-true}" \
    OPENCLAW_PREFER_PNPM=1 \
    /app/scripts/update-openclaw.sh "$OPENCLAW_UPDATE_REF"; then
    export OPENCLAW_ENTRY=/data/openclaw/dist/entry.js
    echo "[update] OpenClaw updated successfully"
  else
    echo "[update] Update failed, using built-in version"
  fi
fi

# A previous update exists on the volume — use it automatically when present.
if [ -z "$OPENCLAW_ENTRY" ] && [ -f /data/openclaw/dist/entry.js ]; then
  export OPENCLAW_ENTRY=/data/openclaw/dist/entry.js
  echo "[update] Using existing updated OpenClaw from /data/openclaw"
fi

# --- pnpm global bin ---
export PNPM_HOME="${PNPM_HOME:-/root/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"

# --- Start OpenClaw ---
exec node --import /app/src/instrumentation.mjs /app/src/server.js
