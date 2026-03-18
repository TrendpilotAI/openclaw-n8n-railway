# OpenClaw Gateway — Claude Code Context

## Project Overview
LLM gateway (OpenWebUI-based) deployed on Railway with Tailscale networking.

## Commands
- **Deploy**: `railway up`
- **Logs**: `railway logs --latest`
- **Status**: `railway status`
- **Health**: `curl http://localhost:8080/healthz`

## Environment Variables
| Variable | Format | Notes |
|---|---|---|
| `XAI_API_KEY` | | NOT GROK_API_KEY |
| `GEMINI_API_KEY` | | NOT GOOGLE_API_KEY |
| `OPENAI_API_KEY` | | |
| `ANTHROPIC_API_KEY` | | |
| `DATABASE_URL` | `postgres://...` | NOT postgresql:// |
| `TAILSCALE_AUTHKEY` | `tskey-auth-...` | Expires — check validity |

## Known Gotchas
- Env var naming mismatches cause silent failures — always use exact names above
- Railway SSH escaping is fragile — prefer `railway logs` over SSH
- Tailscale auth key expires — check if key is valid when networking fails
- Always `railway status` first to verify correct service is linked

---

# OpenClaw Railway Template — Project Rules

## Required Reading: Critical Patterns

Before making config changes or modifying `src/server.js`, review these patterns learned from production incidents.

### Pattern 1: Config Validation = Content Check, Not Existence Check

```javascript
// WRONG — 0-byte file passes, gateway crash loops
if (fs.existsSync(configPath)) { /* assume configured */ }

// CORRECT — validate JSON parseability
const raw = fs.readFileSync(configPath, "utf8").trim();
if (raw && JSON.parse(raw)) { /* actually configured */ }
```

### Pattern 2: Never Enable gateway.tls Behind Railway

`gateway.tls.autoGenerate: true` causes a **silent hang** — no crash, no error, gateway never starts. Railway terminates TLS at the edge; the container receives plain HTTP. Remove `gateway.tls` entirely.

### Pattern 3: gateway.mode Must Be "local" on the Server

The server running the gateway uses `gateway.mode: "local"`. Only remote CLI clients use `"remote"`. Setting `"remote"` on the server = instant crash.

### Pattern 4: maxHistoryShare Minimum is 0.1

Schema enforces minimum 0.1. Setting 0 rejects the config. Use 0.1 to minimize.

### Pattern 5: Apply Bulk Config Changes in Small Groups

Apply 3-5 settings, verify gateway via `/healthz`, then add the next group. One bad setting in a batch of 40 is nearly impossible to find without bisection.

## Architecture

- Express wrapper on `:8080` proxies to internal OpenClaw gateway on `:18789`
- Config lives at `/data/.openclaw/openclaw.json` on Railway volume
- Workspace at `/data/workspace` (skills, memory, etc.)
- TLS handled by Railway edge — internal traffic is plain HTTP

## Railway SSH

Parentheses and braces get mangled by multi-layer shell expansion. Use simple commands only (`grep`, `cat`, `ls`). For complex operations, write a script file first or use the Control UI.

## Conventions

- ES modules, no TypeScript, no CommonJS (except `convex/` which requires `.ts`)
- Vanilla JS for setup wizard UI
- Guard all optional features for graceful degradation
- `redactSecrets()` for any user-facing output
- See `docs/solutions/patterns/` for full incident documentation
