#!/bin/bash
# update-openclaw.sh — Update OpenClaw without a full Docker rebuild.
#
# Usage:
#   ./scripts/update-openclaw.sh [TARGET]
#
# TARGET can be:
#   --stable    Latest release tag (v*)
#   --beta      Latest pre-release tag (v*-beta*, v*-rc*)
#   --canary    Latest main branch commit
#   <ref>       Any branch, tag, or commit SHA (e.g. v2026.3.1, main, fix/auth)
#   (empty)     Defaults to main
#
# The updated build is placed in /data/openclaw. The original /openclaw in the
# Docker image is never modified and serves as a fallback.

set -euo pipefail

OPENCLAW_REPO="https://github.com/openclaw/openclaw.git"
INSTALL_DIR="/data/openclaw"
TARGET="${1:-main}"

log() { echo "[update] $*"; }
die() { echo "[update] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Resolve channel flags to git refs
# ---------------------------------------------------------------------------
resolve_ref() {
  local target="$1"
  case "$target" in
    --stable)
      echo "[update] Resolving --stable (latest release tag)..." >&2
      local tag
      tag=$(git ls-remote --tags --sort=-v:refname "$OPENCLAW_REPO" 'v*' 2>/dev/null \
        | grep -v '\-beta\|\-rc\|\-alpha\|\-dev' \
        | head -1 \
        | awk '{print $2}' \
        | sed 's|refs/tags/||; s|\^{}||')
      if [ -z "$tag" ]; then
        die "No stable release tags found"
      fi
      echo "[update] Resolved --stable → $tag" >&2
      echo "$tag"
      ;;
    --beta)
      echo "[update] Resolving --beta (latest pre-release tag)..." >&2
      local tag
      tag=$(git ls-remote --tags --sort=-v:refname "$OPENCLAW_REPO" 'v*' 2>/dev/null \
        | grep -E '\-beta|\-rc|\-alpha' \
        | head -1 \
        | awk '{print $2}' \
        | sed 's|refs/tags/||; s|\^{}||')
      if [ -z "$tag" ]; then
        die "No beta/rc tags found"
      fi
      echo "[update] Resolved --beta → $tag" >&2
      echo "$tag"
      ;;
    --canary)
      echo "[update] Resolved --canary → main" >&2
      echo "main"
      ;;
    *)
      echo "$target"
      ;;
  esac
}

REF=$(resolve_ref "$TARGET")
log "Target ref: $REF"

# ---------------------------------------------------------------------------
# Clone or fetch
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Existing clone found, fetching updates..."
  cd "$INSTALL_DIR"
  git fetch --all --tags --prune 2>&1 | sed 's/^/  /'
else
  log "Cloning OpenClaw to $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"
  git clone "$OPENCLAW_REPO" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
  cd "$INSTALL_DIR"
fi

# Checkout the target ref
log "Checking out $REF..."
git checkout "$REF" -- 2>&1 | sed 's/^/  /' || true
# If it's a branch, pull latest
if git rev-parse --verify "origin/$REF" >/dev/null 2>&1; then
  git reset --hard "origin/$REF" 2>&1 | sed 's/^/  /'
elif git rev-parse --verify "$REF" >/dev/null 2>&1; then
  git reset --hard "$REF" 2>&1 | sed 's/^/  /'
else
  die "Could not resolve ref: $REF"
fi

RESOLVED_SHA=$(git rev-parse --short HEAD)
log "Checked out $REF at $RESOLVED_SHA"

# ---------------------------------------------------------------------------
# Patch extension package.json files (same as Dockerfile)
# ---------------------------------------------------------------------------
log "Patching extension dependencies..."
find ./extensions -name 'package.json' -type f 2>/dev/null | while read -r f; do
  sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"
  sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"
done

# ---------------------------------------------------------------------------
# Install Bun if not present (OpenClaw build may need it)
# ---------------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash 2>&1 | sed 's/^/  /'
  export PATH="$HOME/.bun/bin:$PATH"
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
log "Installing dependencies (pnpm install)..."
export OPENCLAW_PREFER_PNPM=1
pnpm install --no-frozen-lockfile 2>&1 | tail -5 | sed 's/^/  /'

log "Building OpenClaw (pnpm build)..."
pnpm build 2>&1 | tail -5 | sed 's/^/  /'

log "Building UI (pnpm ui:install + ui:build)..."
pnpm ui:install 2>&1 | tail -3 | sed 's/^/  /'
pnpm ui:build 2>&1 | tail -3 | sed 's/^/  /'

# ---------------------------------------------------------------------------
# Verify the build produced the entry point
# ---------------------------------------------------------------------------
if [ ! -f "$INSTALL_DIR/dist/entry.js" ]; then
  die "Build failed: $INSTALL_DIR/dist/entry.js not found"
fi

# ---------------------------------------------------------------------------
# Update the openclaw wrapper script
# ---------------------------------------------------------------------------
log "Updating /usr/local/bin/openclaw wrapper..."
printf '%s\n' '#!/usr/bin/env bash' "exec node $INSTALL_DIR/dist/entry.js \"\$@\"" > /usr/local/bin/openclaw
chmod +x /usr/local/bin/openclaw

# ---------------------------------------------------------------------------
# Write update info for diagnostics
# ---------------------------------------------------------------------------
cat > "$INSTALL_DIR/.update-info" <<UPDATEEOF
ref=$REF
sha=$RESOLVED_SHA
target=$TARGET
updated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
UPDATEEOF

# ---------------------------------------------------------------------------
# Print version
# ---------------------------------------------------------------------------
VERSION=$(node "$INSTALL_DIR/dist/entry.js" --version 2>/dev/null || echo "unknown")
log "Update complete: OpenClaw $VERSION ($RESOLVED_SHA)"
log "Entry point: $INSTALL_DIR/dist/entry.js"
