# Diagnostic Remediation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 production issues found by `/diag`: DATABASE_URL prefix, duplicate env vars, missing Convex gateway config, WebSocket origin rejection, and unknown Kimi model.

**Architecture:** All fixes are Railway env var changes, OpenClaw gateway config updates, and agent model config corrections. No application code changes needed.

**Tech Stack:** Railway CLI, OpenClaw CLI (via `railway ssh`), Convex dashboard

---

## Context

**Current state of `openclaw.json`** (from Railway SSH):
- `gateway.auth.token` is set to the **plaintext token** (not env-ref — the env-ref PR #11 change was for setup wizard only)
- No `gateway.controlUi` section exists
- No `gateway.trustedProxies` section exists
- `gateway.mode: "local"` is correct

**Kimi model config** (`/data/.openclaw/agents/main/agent/models.json`):
- Provider: `kimi-coding`, model ID: `k2p5`
- HEARTBEAT.md references `kimi/kimi-k2.5` — wrong provider prefix and model ID
- Correct qualified name: `kimi-coding/k2p5`

**Railway env vars with issues:**
- `DATABASE_URL` = `postgresql://...` (should be `postgres://...`)
- `GROK_API_KEY` = duplicate of `XAI_API_KEY`
- `GOOGLE_API_KEY` = duplicate of `GEMINI_API_KEY`

---

### Task 1: Fix DATABASE_URL prefix

**Why:** CLAUDE.md specifies `postgres://` not `postgresql://`. Some libraries fail silently with the wrong prefix.

- [ ] **Step 1: Verify current value**

```bash
railway variables 2>&1 | grep DATABASE_URL
```

Expected: Shows `postgresql://...`

- [ ] **Step 2: Update to postgres:// prefix**

```bash
railway variables set DATABASE_URL="$(railway variables get DATABASE_URL | sed 's|^postgresql://|postgres://|')"
```

If the Railway CLI `get` subcommand doesn't work cleanly, copy the current value from the Railway dashboard, replace `postgresql://` with `postgres://`, and set it there.

- [ ] **Step 3: Verify**

```bash
railway variables 2>&1 | grep DATABASE_URL
```

Expected: Shows `postgres://...`

---

### Task 2: Remove duplicate API key env vars

**Why:** `GROK_API_KEY` and `GOOGLE_API_KEY` are wrong names per CLAUDE.md. The correct vars (`XAI_API_KEY`, `GEMINI_API_KEY`) are already set.

- [ ] **Step 1: Verify duplicates exist**

```bash
railway variables 2>&1 | grep -E "GROK_API_KEY|GOOGLE_API_KEY|XAI_API_KEY|GEMINI_API_KEY"
```

Expected: All 4 present, with matching values for each pair.

- [ ] **Step 2: Remove GROK_API_KEY**

```bash
railway variables delete GROK_API_KEY
```

- [ ] **Step 3: Remove GOOGLE_API_KEY**

```bash
railway variables delete GOOGLE_API_KEY
```

- [ ] **Step 4: Verify only correct names remain**

```bash
railway variables 2>&1 | grep -E "GROK_API_KEY|GOOGLE_API_KEY|XAI_API_KEY|GEMINI_API_KEY"
```

Expected: Only `XAI_API_KEY` and `GEMINI_API_KEY` shown.

---

### Task 3: Set Convex gateway env vars

**Why:** PR #15 moves `gatewayUrl`/`gatewayToken` out of caller args and into Convex environment. These must be set in the Convex dashboard before merging.

- [ ] **Step 1: Open Convex dashboard**

URL: `https://dashboard.convex.dev` (or self-hosted at `https://convex-dashboard-production-*.up.railway.app`)

Navigate to the deployment matching `CONVEX_URL` = `https://warmhearted-goldfish-440.convex.cloud`

- [ ] **Step 2: Set OPENCLAW_GATEWAY_URL**

In Convex dashboard → Settings → Environment Variables, add:

```
OPENCLAW_GATEWAY_URL = https://honey-ai.up.railway.app
```

- [ ] **Step 3: Set OPENCLAW_GATEWAY_TOKEN**

Copy the value of `OPENCLAW_GATEWAY_TOKEN` from Railway:

```
OPENCLAW_GATEWAY_TOKEN = a91b38ecde746165db10544c4bf6fb0b5aca7c4fe096d8295f3a22f6b7290eef
```

Set this in Convex dashboard → Settings → Environment Variables.

- [ ] **Step 4: Set OPENCLAW_CONVEX_SECRET**

Verify it's already set in Convex (it's in Railway as `OPENCLAW_CONVEX_SECRET`). If missing, copy the value:

```
OPENCLAW_CONVEX_SECRET = 6c914b2cb4d47dd567634d61aa9b...
```

- [ ] **Step 5: Verify by testing a workflow**

After merging PR #15 and redeploying Convex:

```bash
curl -X POST https://honey-ai.up.railway.app/setup/api/workflows/heartbeat \
  -H "Content-Type: application/json" \
  -u admin:<SETUP_PASSWORD> \
  -d '{}'
```

Expected: `{"ok":true,"workflowId":"..."}` (not a gateway URL error)

---

### Task 4: Fix WebSocket origin rejection + trusted proxies

**Why:** Logs show ~4 WebSocket rejections per minute. The Control UI at `https://honey-ai.up.railway.app` is blocked because the gateway doesn't recognize the origin or Railway's proxy headers.

- [ ] **Step 1: Add controlUi.allowedOrigins and trustedProxies via SSH**

```bash
railway ssh -s openclaw-railway-template -- openclaw config set gateway.controlUi.allowedOrigins '["https://honey-ai.up.railway.app"]'
```

```bash
railway ssh -s openclaw-railway-template -- openclaw config set gateway.trustedProxies '["100.64.0.0/10","127.0.0.1"]'
```

Note: `100.64.0.0/10` covers Railway's internal CGNAT range used for proxy forwarding.

- [ ] **Step 2: Restart the gateway**

```bash
railway ssh -s openclaw-railway-template -- openclaw gateway restart
```

Or via the setup API:

```bash
curl -X POST https://honey-ai.up.railway.app/setup/api/run \
  -H "Content-Type: application/json" \
  -u admin:<SETUP_PASSWORD> \
  -d '{"cmd":"gateway.restart"}'
```

- [ ] **Step 3: Verify origin is now allowed**

```bash
railway logs --latest 2>&1 | grep "origin not allowed" | tail -5
```

Expected: No new entries after the restart timestamp. Old entries will still be in the log buffer.

- [ ] **Step 4: Verify trusted proxy detection**

```bash
railway logs --latest 2>&1 | grep "untrusted address" | tail -5
```

Expected: No new entries after restart.

---

### Task 5: Fix Kimi model reference

**Why:** Cron jobs reference `kimi/kimi-k2.5` but the provider is `kimi-coding` with model ID `k2p5`. This causes a `FailoverError` every cron cycle, falling back to expensive Opus 4.6.

**Root cause:** HEARTBEAT.md lists the model as `kimi/kimi-k2.5`. The agent's cron system reads this and requests that model. The actual provider/model is `kimi-coding/k2p5`.

- [ ] **Step 1: Update HEARTBEAT.md on the server**

```bash
railway ssh -s openclaw-railway-template -- sed -i 's|kimi/kimi-k2.5|kimi-coding/k2p5|g' /data/workspace/HEARTBEAT.md
```

- [ ] **Step 2: Verify the change**

```bash
railway ssh -s openclaw-railway-template -- grep "kimi" /data/workspace/HEARTBEAT.md
```

Expected: All references now show `kimi-coding/k2p5`.

- [ ] **Step 3: Reload cron jobs**

The agent reads HEARTBEAT.md on its next cron cycle, but to force it:

```bash
railway ssh -s openclaw-railway-template -- openclaw gateway restart
```

- [ ] **Step 4: Wait one cron cycle (~1 min) and verify**

```bash
railway logs --latest 2>&1 | grep "kimi" | tail -10
```

Expected: No more `FailoverError: Unknown model: kimi/kimi-k2.5`. Should see successful `kimi-coding/k2p5` calls or no kimi entries at all if no cron fired yet.

---

## Verification Checklist

After all tasks complete:

- [ ] `railway variables | grep DATABASE_URL` shows `postgres://`
- [ ] `railway variables | grep GROK_API_KEY` shows nothing
- [ ] `railway variables | grep GOOGLE_API_KEY` shows nothing
- [ ] Convex dashboard shows `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_CONVEX_SECRET`
- [ ] `railway logs --latest | grep "origin not allowed"` — no new entries
- [ ] `railway logs --latest | grep "untrusted address"` — no new entries
- [ ] `railway logs --latest | grep "Unknown model: kimi"` — no new entries
- [ ] `curl https://honey-ai.up.railway.app/healthz` returns 200

## Notes

- Task 3 (Convex env vars) must be done **before** merging PR #15, otherwise all Convex workflows will fail with `OPENCLAW_GATEWAY_TOKEN is not configured`
- Tasks 1, 2, 4, 5 can be done in any order and are independent of PR #15
- Task 4 config changes write to `/data/.openclaw/openclaw.json` which persists on the Railway volume
- The `100.64.0.0/10` CIDR is Railway's standard CGNAT range for internal proxy traffic
