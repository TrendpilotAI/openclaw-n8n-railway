#!/usr/bin/env bash
set -euo pipefail

# Configures local OpenClaw CLI to talk to the Railway OpenClaw gateway over Tailscale.
# Also ensures local Tailscale is connected.

HOSTNAME_TAILNET="openclaw-railway.<your-tailnet>.ts.net"
RAILWAY_SERVICE="openclaw-railway-template"
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
SKIP_TAILSCALE_UP=0
SKIP_TOKEN_FETCH=0

usage() {
  cat <<'EOF'
Connect local Mac OpenClaw CLI to Railway gateway over Tailscale.

Usage:
  scripts/connect-mac-to-railway-gateway.sh [options]

Options:
  --host <dns-name>         Tailnet host (default: openclaw-railway.<your-tailnet>.ts.net)
  --service <name>          Railway service for token lookup (default: openclaw-railway-template)
  --token <token>           Explicit gateway token (skips Railway fetch)
  --skip-token-fetch        Do not fetch token from Railway CLI
  --skip-tailscale-up       Do not auto-run `tailscale up`
  -h, --help                Show this help

What it does:
  1) Verifies OpenClaw CLI exists locally
  2) Ensures Tailscale is connected (runs `tailscale up` if needed)
  3) Retrieves gateway token from Railway (unless provided/skipped)
  4) Sets:
       openclaw config set gateway.remote.url wss://<host>
       openclaw config set gateway.remote.token <token>
  5) Validates with:
       openclaw gateway call health --json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOSTNAME_TAILNET="${2:-}"
      shift 2
      ;;
    --service)
      RAILWAY_SERVICE="${2:-}"
      shift 2
      ;;
    --token)
      GATEWAY_TOKEN="${2:-}"
      shift 2
      ;;
    --skip-token-fetch)
      SKIP_TOKEN_FETCH=1
      shift
      ;;
    --skip-tailscale-up)
      SKIP_TAILSCALE_UP=1
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

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not found in PATH." >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found in PATH. Install Tailscale first." >&2
  exit 1
fi

TAILSCALE_OK=0
if tailscale status >/dev/null 2>&1; then
  TAILSCALE_OK=1
fi

if [[ "$TAILSCALE_OK" -ne 1 ]]; then
  if [[ "$SKIP_TAILSCALE_UP" -eq 1 ]]; then
    echo "Tailscale is not connected and --skip-tailscale-up was set." >&2
    exit 1
  fi
  echo "Tailscale appears disconnected. Running: tailscale up"
  tailscale up
fi

# Ensure the target node is visible on tailnet.
if ! tailscale status | grep -q "${HOSTNAME_TAILNET%%.*}"; then
  echo "Warning: ${HOSTNAME_TAILNET%%.*} not found in tailscale status yet."
  echo "Continuing anyway; DNS/propagation may still be in flight."
fi

if [[ -z "$GATEWAY_TOKEN" && "$SKIP_TOKEN_FETCH" -ne 1 ]]; then
  if ! command -v railway >/dev/null 2>&1; then
    echo "railway CLI not found; cannot auto-fetch gateway token." >&2
    echo "Provide --token <value> or install/auth railway CLI." >&2
    exit 1
  fi
  if ! railway whoami >/dev/null 2>&1; then
    echo "railway CLI is not authenticated. Run: railway login" >&2
    exit 1
  fi
  echo "Fetching gateway token from Railway service: $RAILWAY_SERVICE"

  # First try: read the token from the environment variable directly.
  GATEWAY_TOKEN="$(
    railway ssh -s "$RAILWAY_SERVICE" -- sh -lc 'printf %s "${OPENCLAW_GATEWAY_TOKEN:-}"' 2>/dev/null \
      | tr -d '\r'
  )"

  # Second try: read from config (may return env-ref literal like ${OPENCLAW_GATEWAY_TOKEN}).
  if [[ -z "$GATEWAY_TOKEN" ]]; then
    GATEWAY_TOKEN="$(
      railway ssh -s "$RAILWAY_SERVICE" -- openclaw config get gateway.auth.token 2>/dev/null \
        | tail -n 1 \
        | tr -d '\r'
    )"
  fi

  # Detect env-ref literals (e.g. ${OPENCLAW_GATEWAY_TOKEN}) — these are not usable tokens.
  if [[ "$GATEWAY_TOKEN" =~ ^\$\{.+\}$ ]]; then
    echo "Config returned env-ref literal: $GATEWAY_TOKEN" >&2
    echo "The token is stored as an env-ref and could not be resolved." >&2
    echo "Pass --token <value> with the actual token instead." >&2
    GATEWAY_TOKEN=""
  fi
fi

if [[ -z "$GATEWAY_TOKEN" ]]; then
  echo "Gateway token is empty." >&2
  echo "Pass --token <value> or allow Railway token fetch." >&2
  exit 1
fi

GATEWAY_WSS_URL="wss://${HOSTNAME_TAILNET}"
GATEWAY_HTTPS_URL="https://${HOSTNAME_TAILNET}"

echo "Configuring OpenClaw remote gateway:"
echo "  URL:   $GATEWAY_WSS_URL"
echo "  Token: [REDACTED]"

openclaw config set gateway.remote.url "$GATEWAY_WSS_URL" >/dev/null
openclaw config set gateway.remote.token "$GATEWAY_TOKEN" >/dev/null

echo "Validating gateway connectivity..."
openclaw gateway call health --url "$GATEWAY_WSS_URL" --token "$GATEWAY_TOKEN" --json >/dev/null

echo "Connected."
echo "You can now use:"
echo "  openclaw health"
echo "  openclaw status --usage"
echo "  openclaw dashboard"
echo "Dashboard URL:"
echo "  $GATEWAY_HTTPS_URL"
