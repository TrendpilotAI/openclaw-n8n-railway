<img width="1024" height="501" alt="image" src="https://github.com/user-attachments/assets/bb943f0b-1ed3-4dfc-bb95-b87302c410a5" />

# OpenClaw AI Agent Stack on Railway — n8n Workflows, Tailscale Mesh, GPU Compute & 500+ Integrations

The complete autonomous AI infrastructure stack. Deploy [OpenClaw](https://github.com/openclaw/openclaw) + [n8n](https://n8n.io/) to Railway with Tailscale encrypted mesh networking, on-demand Modal GPU compute, and 500+ SaaS integrations — all pre-wired and ready from a single browser-based setup wizard. **One click. Zero SSH. 90%+ LLM cost savings out of the box.**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/cDVYRI)

[![Railway Deploy](https://img.shields.io/badge/Deploy-Railway-7B2FBE?logo=railway)](https://railway.com/deploy/cDVYRI)
[![License](https://img.shields.io/github/license/TrendpilotAI/openclaw-n8n-railway)](LICENSE)
[![Stars](https://img.shields.io/github/stars/TrendpilotAI/openclaw-n8n-railway)](https://github.com/TrendpilotAI/openclaw-n8n-railway/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/TrendpilotAI/openclaw-n8n-railway)](https://github.com/TrendpilotAI/openclaw-n8n-railway/commits/main)

> The standard OpenClaw Railway template gives you a gateway. This gives you the full stack.

|  | Bare OpenClaw | This Template |
|---|:---:|:---:|
| n8n workflow automation | ✗ | ✓ |
| Tailscale mesh access | ✗ | ✓ |
| Modal GPU compute | ✗ | ✓ |
| 500+ SaaS integrations | ✗ | ✓ |
| LLM cost optimization | Manual | **Auto (90%+ savings)** |
| Setup | CLI | **Browser wizard** |

---

## What Gets Deployed

One click deploys the full stack. All companion services are pre-wired via Railway reference variables — no manual secret sharing or internal URL configuration required.

### Core (always deployed)

| Service | Source | Purpose |
|---|---|---|
| **OpenClaw** | This repo (Dockerfile) | AI gateway with setup wizard, Tailscale mesh, and 4-platform compute routing |

### Companion Services (optional — delete any you don't need)

| Service | Image | Purpose | Depends On |
|---|---|---|---|
| **n8n Primary** | `n8nio/n8n` | Workflow automation engine with AI agent nodes | Postgres, Redis |
| **n8n Worker** | `n8nio/n8n` | Background workflow execution (queue mode) | n8n Primary, Postgres, Redis |
| **Postgres** | `postgres-ssl:17` | Persistent storage for n8n, Postiz, and Temporal | — |
| **Redis** | `redis:8.2.1` | Queue/cache backend for n8n and Postiz | — |
| **Postiz** | `postiz-app` | Social media scheduling and automation | Postgres, Redis |
| **Temporal** | `temporalio/auto-setup` | Distributed workflow orchestration | Postgres |

### Also Included

- Tailscale encrypted mesh networking (embedded in OpenClaw container — no extra service)
- 39 skills, 3 CLI tools, and 500+ SaaS integrations via Composio out of the box
- OpenTelemetry tracing with Langfuse (LLM evals) and PostHog (product analytics)
- Cost-optimized defaults that reduce API spend by 90%+
- Browser-based setup wizard at `/setup` — no terminal required

---

## Prerequisites

You need: Railway account (2 min), Tailscale auth key (3 min), one LLM API key (already have). **Total setup: under 10 minutes.**

1. **Railway account** — [railway.app](https://railway.app/)
2. **Tailscale account** — [tailscale.com](https://tailscale.com/) (free for personal use)
3. **Tailscale auth key** — Generate at [Tailscale Admin > Keys](https://login.tailscale.com/admin/settings/keys)
   - Enable **Reusable** and **Ephemeral** (recommended)
   - Pre-approve the key to skip manual device approval
4. **LLM API key** — Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Grok, or Kimi

---

## Quick Start

### 1. Deploy to Railway

Click the deploy button above, or:

1. Fork this repo to your GitHub account
2. Create a new project in Railway
3. Select "Deploy from GitHub repo" and pick your fork
4. Add a **Volume** mounted at `/data` (persists config and workspace across deploys)

### 2. Set Environment Variables

The template auto-generates secrets and wires all cross-service connections. You only need to fill in three values:

| Variable | Required | Description |
|---|---|---|
| `SETUP_PASSWORD` | Yes | Password to access the `/setup` wizard |
| `TAILSCALE_AUTHKEY` | Yes | Tailscale auth key (reusable + ephemeral) |
| `ANTHROPIC_API_KEY` | Recommended | Set here or enter during the setup wizard |

Everything else is pre-configured with sensible defaults. See [`.env.example`](.env.example) for the full variable list.

### 3. Run the Setup Wizard

Once deployed, open your Railway service URL and navigate to `/setup`. Enter your `SETUP_PASSWORD` and follow the wizard:

1. Choose your model provider (Anthropic, OpenAI, Google, etc.)
2. Enter your API key
3. Optionally configure Telegram, Discord, or Slack channels
4. Click **Run setup**

The wizard applies cost-optimized defaults, copies 39 skills to your workspace, and starts the gateway automatically.

### 4. Connect from Your Local Machine

With Tailscale installed on your Mac/PC, your Railway instance appears on your tailnet:

```bash
# Verify the instance is visible
tailscale status | grep openclaw

# The OpenClaw gateway is accessible at:
# https://openclaw-railway.<tailnet>.ts.net
```

Your local OpenClaw CLI connects to the remote gateway over Tailscale — no SSH, no exposed ports.

---

## Common Configurations

After deploying, delete any companion services you don't need from the Railway dashboard to reduce cost.

| Configuration | Keep | Delete |
|---|---|---|
| **OpenClaw only** | OpenClaw | n8n, Postgres, Redis, Postiz, Temporal |
| **OpenClaw + n8n** | OpenClaw, n8n Primary, n8n Worker, Postgres, Redis | Postiz, Temporal |
| **Full stack** | Everything | — |

---

## Architecture

### Request Flow

```
Internet → Railway :8080 → Express (server.js)
                                │
              ┌─────────────────┴──────────────────┐
              │                                     │
         /setup/* routes                   All other routes
         (setup wizard)                    (proxy to gateway)
              │                                     │
              ▼                                     ▼
          Setup UI                         Gateway :18789
          (browser)                        (OpenClaw core)
                                                    │
                                    ┌───────────────┼───────────────┐
                                    │               │               │
                                   LLM           Skills            n8n
                                  (API)          (tools)        (webhooks)
```

- Express listens on port 8080 (Railway's public domain)
- `/setup/*` routes serve the setup wizard UI (protected by `SETUP_PASSWORD`)
- All other routes proxy to the OpenClaw gateway on `127.0.0.1:18789`
- The gateway only binds to loopback — never directly exposed to the internet
- Tailscale provides end-to-end encrypted access from your local machine

### Compute Routing

The template routes workloads across 4 platforms automatically:

| Platform | Best For | Cost |
|---|---|---|
| **Railway** (this container) | Gateway, web server, cron, lightweight CLI tasks | ~$5–20/mo fixed |
| **Modal** (serverless) | ML inference, image/video gen, batch processing | Pay-per-second |
| **n8n** (orchestration) | Multi-step workflows, scheduled jobs, webhook chains | Included in Railway plan |
| **Composio** (SaaS bridge) | Direct SaaS actions (email, Slack, GitHub, CRM) | Free tier available |

**Examples:**
```
"Fix the auth bug in middleware.ts"     → Railway local + Claude Opus
"Generate 100 product thumbnails"       → Modal A10G GPU + vision model
"Every morning, email a sales report"   → n8n scheduled workflow
"Post a message to Slack"               → Composio Rube MCP
```

---

## Cost Optimization (Auto-Applied)

This template applies cost-optimized defaults on first setup that **reduce LLM API spend by 90%+**:

| Setting | Value | Why |
|---|---|---|
| **Heartbeat model** | Free-tier via OpenRouter | Background checks use the cheapest compatible model |
| **Active hours** | 06:00–23:00 UTC | Skip heartbeats while nobody's awake |
| **Context pruning** | `cache-ttl` with 6h TTL | Reduce token bloat automatically |
| **Memory compaction** | Flush at 40k tokens | Distill sessions into daily memory files |
| **Concurrency limits** | 4 agents, 8 subagents max | Prevent runaway token consumption |

### Multi-Provider Auto-Registration

Set multiple API keys in Railway Variables — every available provider is detected and registered automatically at boot:

| Variable | Provider | Models |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| `OPENAI_API_KEY` | OpenAI | GPT-4.1, GPT-4.1 Mini, GPT-4.1 Nano |
| `DEEPSEEK_API_KEY` | DeepSeek | DeepSeek Chat (V3), DeepSeek Reasoner (R1) |
| `GROK_API_KEY` | xAI | Grok 3, Grok 3 Mini |
| `KIMI_API_KEY` | Moonshot | Kimi K2 |

### Heartbeat Fallback Chain

Free-tier models via OpenRouter with automatic failover:
1. `nvidia/nemotron-3-nano-30b-a3b:free` — primary (256K context)
2. `stepfun/step-3.5-flash:free` — fallback (256K context)
3. `upstage/solar-pro-3:free` — fallback (128K context)
4. `arcee-ai/trinity-mini:free` — fallback (131K context)

---

## Pre-Installed Skills & Tools

39 skills and 3 CLI tools ship with this template — your instance is productive from first boot.

### Skills by Category

**Railway (7 skills)** — deploy, status, environment, service, database, domain, projects

**n8n (8 skills)** — workflow patterns, JavaScript/Python code nodes, node configuration, expression syntax, MCP tools, validation, full knowledge base (545 node docs, 20 templates)

**Development & DevOps (4 skills)** — coding agent (Claude Code, Codex CLI), PR creator, TDD workflow, implementation planning

**Communication & Productivity (4 skills)** — Google Workspace CLI, email (IMAP/SMTP), WhatsApp CLI, Jira

**Research & Analytics (5 skills)** — last 30 days research (Reddit, X, YouTube, web), data storytelling, visualization, project planning, strategy advisory

**Content & Creative (3 skills)** — changelog social announcements, scientific slides, viral generator builder

### CLI Tools (pre-installed in Docker)

| Tool | Purpose |
|---|---|
| **Rube MCP** (`@composio/rube-mcp`) | 500+ SaaS integrations (Gmail, Slack, Notion, GitHub, and more) |
| **yt-dlp** | YouTube video metadata and transcript extraction |
| **Modal** | Serverless GPU/compute — deploy functions, run batch jobs on A10G/A100/H100 |
| **Homebrew** | Install additional CLI tools at runtime |

---

## Observability

Built-in OpenTelemetry instrumentation — all tracing is opt-in and degrades gracefully if no keys are set.

| Backend | Purpose | Required Variables |
|---|---|---|
| **Langfuse** | LLM tracing, evals, cost tracking | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` |
| **PostHog** | Product analytics (setup and gateway events) | `POSTHOG_API_KEY` |
| **OTLP** | Generic APM (Grafana, Jaeger, etc.) | `OTEL_EXPORTER_OTLP_ENDPOINT` |

---

## Managing Your Instance

### Setup Wizard (`/setup`)

- **Status** — Gateway health, version, links to the OpenClaw UI
- **Debug console** — Run safe diagnostics without SSH
- **Config editor** — Edit `openclaw.json` with backup
- **Backup/restore** — Download and upload `.tar.gz` archives of `/data`
- **Device pairing** — Approve Telegram/Discord DM pairing requests

### Updating OpenClaw

**Live update (no restart):** Open `/setup` → Debug console → `openclaw.update` → enter a ref:

```bash
--stable    # Latest release tag
--beta      # Latest pre-release
--canary    # Latest main branch commit
v2026.3.1   # Pin to a specific version
```

**Boot-time update (no rebuild):** Set `OPENCLAW_UPDATE_REF` in Railway Variables.

**Full Docker rebuild:** Redeploy from Railway dashboard (~10 min). Pin a version with build arg `OPENCLAW_GIT_REF=v2026.2.19`.

### Safe Restart

To restart only OpenClaw without touching companion services:

```bash
scripts/safe-restart-openclaw.sh --yes
```

### Connect Your Local Mac CLI

```bash
scripts/connect-mac-to-railway-gateway.sh
```

Verifies Tailscale, fetches the gateway token from Railway, and configures your local OpenClaw CLI against the remote gateway automatically.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:18789` | Gateway not started | Check `/setup/api/debug`, verify API key is set |
| `Gateway did not become ready in time` | Timeout | Increase `healthcheckTimeout` in `railway.toml` |
| `No model providers configured` | Missing API key | Set `ANTHROPIC_API_KEY` or another LLM key in Railway Variables |
| n8n `relation does not exist` | DB not connected | Check `DB_POSTGRESDB_HOST` spelling, redeploy n8n |
| Tailscale not connecting | Expired or unapproved key | Verify `TAILSCALE_AUTHKEY` is reusable + ephemeral + pre-approved |
| No traces in Langfuse | Missing keys | Set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` |

For full troubleshooting details, visit `/setup/api/debug` for live diagnostics or open the Debug console at `/setup` and run `openclaw doctor`.

---

## Security

- Setup wizard protected by `SETUP_PASSWORD` via HTTP Basic auth
- OpenClaw gateway binds to `127.0.
