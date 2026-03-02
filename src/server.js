import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { trace } from "@opentelemetry/api";
import { ConvexHttpClient } from "convex/browser";
import express from "express";
import httpProxy from "http-proxy";
import { PostHog } from "posthog-node";
import * as tar from "tar";

/** @type {Set<string>} */
const warnedDeprecatedEnv = new Set();

/**
 * Prefer `primaryKey`, fall back to `deprecatedKey` with a one-time warning.
 * @param {string} primaryKey
 * @param {string} deprecatedKey
 */
function getEnvWithShim(primaryKey, deprecatedKey) {
  const primary = process.env[primaryKey]?.trim();
  if (primary) return primary;

  const deprecated = process.env[deprecatedKey]?.trim();
  if (!deprecated) return undefined;

  if (!warnedDeprecatedEnv.has(deprecatedKey)) {
    console.warn(
      `[deprecation] ${deprecatedKey} is deprecated. Use ${primaryKey} instead.`,
    );
    warnedDeprecatedEnv.add(deprecatedKey);
  }

  return deprecated;
}

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
const PORT = Number.parseInt(
  getEnvWithShim("OPENCLAW_PUBLIC_PORT", "CLAWDBOT_PUBLIC_PORT") ??
    process.env.PORT ??
    "8080",
  10,
);

// State/workspace
// OpenClaw defaults to ~/.openclaw.
const STATE_DIR =
  getEnvWithShim("OPENCLAW_STATE_DIR", "CLAWDBOT_STATE_DIR") ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  getEnvWithShim("OPENCLAW_WORKSPACE_DIR", "CLAWDBOT_WORKSPACE_DIR") ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = getEnvWithShim(
    "OPENCLAW_GATEWAY_TOKEN",
    "CLAWDBOT_GATEWAY_TOKEN",
  );
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Webhook hooks token for OpenClaw <-> n8n bridge.
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN?.trim() || "";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL?.trim() || "";

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
// Read at call time (not module load) so hot updates via `openclaw.update` take effect immediately.
function getOpenClawEntry() {
  return process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
}
function getOpenClawNode() {
  return process.env.OPENCLAW_NODE?.trim() || "node";
}

// PostHog product analytics (guarded — no crash if key not set).
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY?.trim();
const posthog = POSTHOG_API_KEY
  ? new PostHog(POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      flushAt: 10,
      flushInterval: 30_000,
    })
  : null;

// Convex workflow orchestration (guarded — no crash if URL not set).
// Set CONVEX_URL in Railway env vars after deploying the Convex backend service.
const CONVEX_URL = process.env.CONVEX_URL?.trim() || "";
const CONVEX_SECRET = process.env.OPENCLAW_CONVEX_SECRET?.trim() || undefined;

/**
 * Create a fresh ConvexHttpClient per request.
 * The client is stateful (holds credentials + mutation queue), so sharing a
 * single instance across concurrent Express requests would leak state.
 * Returns null when Convex is not configured.
 *
 * NOTE: ConvexHttpClient is a stateless HTTP client — it uses fetch() per call
 * and holds no persistent connections, sockets, or timers.  There is no
 * `.close()` / `.destroy()` / `.dispose()` method on its prototype, so callers
 * do not need to perform cleanup.  The instance is eligible for GC as soon as
 * the request handler returns.  (Verified against convex/browser — see PR #XX.)
 *
 * @returns {import("convex/browser").ConvexHttpClient | null}
 */
function createConvexClient() {
  if (!CONVEX_URL) return null;
  return new ConvexHttpClient(CONVEX_URL);
}

/** Track an event in PostHog with optional OTel trace correlation. */
function trackEvent(event, properties = {}) {
  if (!posthog) return;
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext()?.traceId;
  posthog.capture({
    distinctId: process.env.RAILWAY_SERVICE_ID || "openclaw-railway",
    event,
    properties: {
      ...properties,
      ...(traceId ? { otel_trace_id: traceId } : {}),
      railway_commit: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    },
  });
}

function clawArgs(args) {
  return [getOpenClawEntry(), ...args];
}

function resolveConfigCandidates() {
  const explicit = getEnvWithShim("OPENCLAW_CONFIG_PATH", "CLAWDBOT_CONFIG_PATH");
  if (explicit) return [explicit];

  // Prefer the newest canonical name, but fall back to legacy filenames if present.
  return [
    path.join(STATE_DIR, "openclaw.json"),
    path.join(STATE_DIR, "moltbot.json"),
    path.join(STATE_DIR, "clawdbot.json"),
  ];
}

function configPath() {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  // Default to canonical even if it doesn't exist yet.
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    return resolveConfigCandidates().some((candidate) => {
      if (!fs.existsSync(candidate)) return false;
      try {
        const raw = fs.readFileSync(candidate, "utf8").trim();
        if (!raw) return false;
        JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Write a file atomically (write to temp, then rename) to prevent corruption
 * from mid-write crashes or signals.
 */
function atomicWriteFile(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Create a timestamped backup of the config file (if it exists and is valid JSON).
 * Keeps the last 5 auto-backups, pruning older ones.
 */
function backupConfigIfExists() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf8").trim();
    if (!raw) return;
    try { JSON.parse(raw); } catch { return; } // only backup valid JSON

    const backupPath = `${p}.auto-bak-${Date.now()}`;
    fs.copyFileSync(p, backupPath);

    const dir = path.dirname(p);
    const base = path.basename(p);
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.auto-bak-`))
      .sort()
      .reverse();
    for (const old of backups.slice(5)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch {}
    }
  } catch (err) {
    console.warn(`[wrapper] config backup failed: ${String(err)}`);
  }
}

/**
 * Attempt to recover config from the most recent valid backup.
 * Searches both auto-backups and manual backups.
 */
function recoverFromBackup() {
  try {
    const p = configPath();
    const dir = path.dirname(p);
    const base = path.basename(p);
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.auto-bak-`) || f.startsWith(`${base}.bak-`))
      .sort()
      .reverse();

    for (const backup of backups) {
      try {
        const raw = fs.readFileSync(path.join(dir, backup), "utf8");
        JSON.parse(raw); // validate
        fs.copyFileSync(path.join(dir, backup), p);
        console.log(`[wrapper] recovered config from backup: ${backup}`);
        return true;
      } catch { continue; }
    }
  } catch {}
  console.error("[wrapper] no valid backup found for recovery");
  return false;
}

/**
 * Clean config before gateway start:
 * 1. Handle empty/corrupt config files
 * 2. Remove gateway.bind (managed via CLI args)
 * 3. Run `openclaw doctor --fix` to strip any unrecognized schema keys
 */
async function cleanupStaleConfigKeys() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) {
      console.warn("[wrapper] config file is empty; removing to allow re-setup");
      fs.unlinkSync(p);
      return;
    }
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (parseErr) {
      console.warn(`[wrapper] config file is corrupt; removing to allow re-setup: ${parseErr.message}`);
      fs.unlinkSync(p);
      return;
    }

    // Remove keys managed via CLI args (these break across version upgrades)
    let changed = false;
    if (cfg.gateway?.bind !== undefined) {
      delete cfg.gateway.bind;
      changed = true;
    }

    // Remove unrecognized nested keys that doctor --fix sometimes can't handle.
    // These cause crash loops because the gateway refuses to start with invalid config.
    const STALE_KEYS = [
      ["channels", "discord", "allowedChannels"],
      ["channels", "discord", "streaming"],
      ["channels", "telegram", "streaming"],
      ["channels", "slack", "nativeStreaming"],
      ["commands", "ownerDisplay"],
    ];
    for (const keyPath of STALE_KEYS) {
      let obj = cfg;
      for (let i = 0; i < keyPath.length - 1; i++) {
        obj = obj?.[keyPath[i]];
        if (!obj || typeof obj !== "object") break;
      }
      if (obj && typeof obj === "object" && keyPath[keyPath.length - 1] in obj) {
        delete obj[keyPath[keyPath.length - 1]];
        changed = true;
        console.log(`[wrapper] removed stale config key: ${keyPath.join(".")}`);
      }
    }

    // Fix known invalid enum values that crash the gateway.
    const VALID_GROUP_POLICIES = new Set(["open", "disabled", "allowlist"]);
    if (cfg.channels?.discord?.groupPolicy && !VALID_GROUP_POLICIES.has(cfg.channels.discord.groupPolicy)) {
      console.log(`[wrapper] fixing invalid discord.groupPolicy: "${cfg.channels.discord.groupPolicy}" → "disabled"`);
      cfg.channels.discord.groupPolicy = "disabled";
      changed = true;
    }

    if (changed) {
      atomicWriteFile(p, JSON.stringify(cfg, null, 2));
      console.log("[wrapper] config cleaned up");
    }

    // Run openclaw doctor --fix to strip any remaining unrecognized keys from the schema.
    // This is the primary defense against crash loops caused by config drift.
    console.log("[wrapper] running openclaw doctor --fix to validate config...");
    const result = await runCmd(getOpenClawNode(), clawArgs(["doctor", "--fix"]), { timeout: 60_000 });
    if (result.code === 0) {
      console.log("[wrapper] doctor --fix completed successfully");
    } else {
      console.warn(`[wrapper] doctor --fix exited ${result.code}: ${(result.output || "").slice(0, 500)}`);
    }
  } catch (err) {
    console.warn(`[wrapper] config cleanup failed (non-fatal): ${String(err)}`);
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;

// Debug breadcrumbs for common Railway failures (502 / "Application failed to respond").
let lastGatewayError = null;
let lastGatewayExit = null;
let lastDoctorOutput = null;
let lastDoctorAt = null;

// Crash recovery with exponential backoff and safe mode.
let crashCount = 0;
let lastCrashTime = 0;
const CRASH_RESET_WINDOW = 5 * 60 * 1000; // 5min stability resets counter
const BASE_DELAY = 2000;
const MAX_DELAY = 60_000;
const MAX_CRASHES = 10;

function calculateRestartDelay() {
  const now = Date.now();
  if (now - lastCrashTime > CRASH_RESET_WINDOW) {
    crashCount = 0;
  }
  crashCount++;
  lastCrashTime = now;
  if (crashCount > MAX_CRASHES) return null; // safe mode
  const delay = Math.min(BASE_DELAY * Math.pow(2, crashCount - 1), MAX_DELAY);
  const jitter = Math.random() * 1000;
  return Math.round(delay + jitter);
}

function resetCrashCounter() {
  crashCount = 0;
  lastCrashTime = 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(INTERNAL_GATEWAY_HOST, INTERNAL_GATEWAY_PORT)) return true;
    await sleep(500);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  // Wait for the port to be free before starting (prevents "already listening" errors after crashes).
  const portFreeDeadline = Date.now() + 10_000;
  while (await checkPort(INTERNAL_GATEWAY_HOST, INTERNAL_GATEWAY_PORT, 500)) {
    if (Date.now() > portFreeDeadline) {
      console.warn(`[wrapper] port ${INTERNAL_GATEWAY_PORT} still in use after 10s; proceeding anyway`);
      break;
    }
    console.log(`[wrapper] waiting for port ${INTERNAL_GATEWAY_PORT} to be released...`);
    await sleep(1000);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(getOpenClawNode(), clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    const msg = `[gateway] spawn error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    const msg = `[gateway] exited code=${code} signal=${signal}`;
    console.error(msg);
    lastGatewayExit = { code, signal, at: new Date().toISOString(), crashCount };
    gatewayProc = null;

    // Don't auto-restart on intentional shutdown or if wrapper is shutting down.
    if (signal === "SIGTERM" || shuttingDown) return;
    if (!isConfigured()) return;

    const delay = calculateRestartDelay();
    if (delay === null) {
      console.error(`[wrapper] gateway has crashed ${crashCount} times -- entering safe mode`);
      console.error("[wrapper] safe mode: gateway will NOT auto-restart. Use /setup debug console to manually restart.");
      return;
    }

    console.log(`[wrapper] gateway crashed (attempt ${crashCount}/${MAX_CRASHES}); auto-restarting in ${(delay / 1000).toFixed(1)}s...`);

    // After 3+ crashes, attempt config recovery from backup before restarting
    if (crashCount >= 3) {
      console.warn("[wrapper] 3+ crashes, attempting config recovery from backup");
      recoverFromBackup();
    }

    setTimeout(async () => {
      if (gatewayProc || !isConfigured() || shuttingDown) return;
      try {
        await cleanupStaleConfigKeys();
        await ensureGatewayRunning();
        console.log("[wrapper] gateway auto-restarted");
      } catch (err) {
        console.error(`[wrapper] gateway auto-restart failed: ${String(err)}`);
      }
    }, delay);
  });
}

async function runDoctorBestEffort() {
  // Avoid spamming `openclaw doctor` in a crash loop.
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;

  try {
    const r = await runCmd(getOpenClawNode(), clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        backupConfigIfExists();
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
        if (!ready) {
          // The process may still be alive and initializing — don't throw if
          // the child process is still running. Railway cold-starts can be slow.
          if (gatewayProc) {
            console.warn("[wrapper] readiness check timed out but gateway process is alive; continuing");
          } else {
            throw new Error("Gateway did not become ready in time");
          }
        }
      } catch (err) {
        const msg = `[gateway] start failure: ${String(err)}`;
        lastGatewayError = msg;
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  // Manual restarts exit safe mode.
  resetCrashCounter();
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ---------------------------------------------------------------------------
// Setup auth with rate limiting
// ---------------------------------------------------------------------------
/** @type {Map<string, { count: number, blockedUntil: number }>} */
const authAttempts = new Map();
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** Prune expired entries periodically to avoid unbounded growth. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) {
    if (now > entry.blockedUntil && entry.count === 0) authAttempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  // Rate limiting by IP.
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = authAttempts.get(ip) || { count: 0, blockedUntil: 0 };

  if (now < entry.blockedUntil) {
    const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).send(`Too many attempts. Try again in ${retryAfter}s.`);
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";

  // Timing-safe comparison to prevent side-channel attacks.
  const pwBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(SETUP_PASSWORD);
  const match = pwBuf.length === expectedBuf.length && crypto.timingSafeEqual(pwBuf, expectedBuf);

  if (!match) {
    entry.count += 1;
    // Exponential backoff: 2^(attempts-threshold) seconds, capped at 15 minutes.
    if (entry.count >= AUTH_MAX_ATTEMPTS) {
      const backoffMs = Math.min(Math.pow(2, entry.count - AUTH_MAX_ATTEMPTS) * 1000, AUTH_WINDOW_MS);
      entry.blockedUntil = now + backoffMs;
    }
    authAttempts.set(ip, entry);
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }

  // Reset on successful auth.
  authAttempts.delete(ip);
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway. Always returns 200 (Railway needs this to
// consider the deploy healthy). Includes diagnostic fields for external monitoring.
app.get("/setup/healthz", (_req, res) => res.json({
  ok: true,
  gateway: {
    configured: isConfigured(),
    running: Boolean(gatewayProc),
    safeMode: crashCount > MAX_CRASHES,
    crashCount,
  },
  convex: {
    enabled: Boolean(CONVEX_URL),
  },
}));

// Public health endpoint (no auth) so Railway can probe without /setup.
// Deliberately minimal — no internal paths, targets, or error details.
app.get("/healthz", async (_req, res) => {
  let gatewayReachable = false;
  if (isConfigured() && gatewayProc) {
    try {
      const probe = await fetch(`${GATEWAY_TARGET}/`, { method: "GET", signal: AbortSignal.timeout(3000) });
      gatewayReachable = Boolean(probe);
    } catch {
      gatewayReachable = false;
    }
  }

  res.json({
    ok: true,
    configured: isConfigured(),
    gateway: {
      running: Boolean(gatewayProc),
      reachable: gatewayReachable,
    },
  });
});

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  // No inline <script>: serve JS from /setup/app.js to avoid any encoding/template-literal issues.
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem; max-width: 900px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: #111; color: #fff; font-weight: 700; cursor: pointer; }
    code { background: #f6f6f6; padding: 0.1rem 0.3rem; border-radius: 6px; }
    .muted { color: #555; }
  </style>
</head>
<body>
  <h1>OpenClaw Setup</h1>
  <p class="muted">This wizard configures OpenClaw by running the same onboarding command it uses in the terminal, but from the browser.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div id="statusDetails" class="muted" style="margin-top:0.5rem"></div>
    <div style="margin-top: 0.75rem">
      <a href="/openclaw" target="_blank">Open OpenClaw UI</a>
      &nbsp;|&nbsp;
      <a href="/setup/export" target="_blank">Download backup (.tar.gz)</a>
    </div>

    <div style="margin-top: 0.75rem">
      <div class="muted" style="margin-bottom:0.25rem"><strong>Import backup</strong> (advanced): restores into <code>/data</code> and restarts the gateway.</div>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip" />
      <button id="importRun" style="background:#7c2d12; margin-top:0.5rem">Import</button>
      <pre id="importOut" style="white-space:pre-wrap"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Debug console</h2>
    <p class="muted">Run a small allowlist of safe commands (no shell). Useful for debugging and recovery.</p>

    <div style="display:flex; gap:0.5rem; align-items:center">
      <select id="consoleCmd" style="flex: 1">
        <option value="gateway.restart">gateway.restart (wrapper-managed)</option>
        <option value="gateway.stop">gateway.stop (wrapper-managed)</option>
        <option value="gateway.start">gateway.start (wrapper-managed)</option>
        <option value="openclaw.status">openclaw status</option>
        <option value="openclaw.health">openclaw health</option>
        <option value="openclaw.doctor">openclaw doctor</option>
        <option value="openclaw.logs.tail">openclaw logs --tail N</option>
        <option value="openclaw.config.get">openclaw config get &lt;path&gt;</option>
        <option value="openclaw.version">openclaw --version</option>
        <option value="openclaw.devices.list">openclaw devices list</option>
        <option value="openclaw.devices.approve">openclaw devices approve &lt;requestId&gt;</option>
        <option value="openclaw.plugins.list">openclaw plugins list</option>
        <option value="openclaw.plugins.enable">openclaw plugins enable &lt;name&gt;</option>
        <option value="claude.usage">claude usage (API/token usage check)</option>
        <option value="openclaw.update">openclaw.update (--stable | --beta | --canary | ref)</option>
      </select>
      <input id="consoleArg" placeholder="Optional arg (e.g. 200, gateway.port)" style="flex: 1" />
      <button id="consoleRun" style="background:#0f172a">Run</button>
    </div>
    <pre id="consoleOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>Config editor (advanced)</h2>
    <p class="muted">Edits the full config file on disk (JSON5). Saving creates a timestamped <code>.bak-*</code> backup and restarts the gateway.</p>
    <div class="muted" id="configPath"></div>
    <textarea id="configText" style="width:100%; height: 260px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
    <div style="margin-top:0.5rem">
      <button id="configReload" style="background:#1f2937">Reload</button>
      <button id="configSave" style="background:#111; margin-left:0.5rem">Save</button>
    </div>
    <pre id="configOut" style="white-space:pre-wrap"></pre>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Matches the groups shown in the terminal onboarding.</p>
    <label>Provider group</label>
    <select id="authGroup"></select>

    <label>Auth method</label>
    <select id="authChoice"></select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token if applicable" />

    <label>Wizard flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can also add channels later inside OpenClaw, but this helps you get messaging working immediately.</p>

    <label>Telegram bot token (optional)</label>
    <input id="telegramToken" type="password" placeholder="123456:ABC..." />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
    </div>

    <label>Discord bot token (optional)</label>
    <input id="discordToken" type="password" placeholder="Bot token" />
    <div class="muted" style="margin-top: 0.25rem">
      Get it from the Discord Developer Portal: create an application, add a Bot, then copy the Bot Token.<br/>
      <strong>Important:</strong> Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot → Privileged Gateway Intents, or the bot will crash on startup.
    </div>

    <label>Slack bot token (optional)</label>
    <input id="slackBotToken" type="password" placeholder="xoxb-..." />

    <label>Slack app token (optional)</label>
    <input id="slackAppToken" type="password" placeholder="xapp-..." />
  </div>

  <div class="card">
    <h2>2b) Advanced: Custom OpenAI-compatible provider (optional)</h2>
    <p class="muted">Use this to configure an OpenAI-compatible API that requires a custom base URL (e.g. Ollama, vLLM, LM Studio, hosted proxies). You usually set the API key as a Railway variable and reference it here.</p>

    <label>Provider id (e.g. ollama, deepseek, myproxy)</label>
    <input id="customProviderId" placeholder="ollama" />

    <label>Base URL (must include /v1, e.g. http://host:11434/v1)</label>
    <input id="customProviderBaseUrl" placeholder="http://127.0.0.1:11434/v1" />

    <label>API (openai-completions or openai-responses)</label>
    <select id="customProviderApi">
      <option value="openai-completions">openai-completions</option>
      <option value="openai-responses">openai-responses</option>
    </select>

    <label>API key env var name (optional, e.g. OLLAMA_API_KEY). Leave blank for no key.</label>
    <input id="customProviderApiKeyEnv" placeholder="OLLAMA_API_KEY" />

    <label>Optional model id to register (e.g. llama3.1:8b)</label>
    <input id="customProviderModelId" placeholder="" />
  </div>

  <div class="card">
    <h2>3) Run onboarding</h2>
    <button id="run">Run setup</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset setup</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">Reset deletes the OpenClaw config file so you can rerun onboarding. Pairing approval lets you grant DM access when dmPolicy=pairing.</p>

    <details style="margin-top: 0.75rem">
      <summary><strong>Pairing helper</strong> (for “disconnected (1008): pairing required”)</summary>
      <p class="muted">This lists pending device requests and lets you approve them without SSH.</p>
      <button id="devicesRefresh" style="background:#0f172a">Refresh pending devices</button>
      <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
    </details>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`);
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(getOpenClawNode(), clawArgs(["--version"]));
  const channelsHelp = await runCmd(getOpenClawNode(), clawArgs(["channels", "add", "--help"]));

  // We reuse OpenClaw's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  // NOTE: On Railway, interactive OAuth flows are typically not viable. The UI will hide them by default.
  const authGroups = [
    { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" }
    ]},
    { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" }
    ]},
    { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
    ]},
    { value: "openrouter", label: "OpenRouter", hint: "API key", options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" }
    ]},
    { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
    ]},
    { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" }
    ]},
    { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
      { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
    ]},
    { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
    ]},
    { value: "qwen", label: "Qwen", hint: "OAuth", options: [
      { value: "qwen-portal", label: "Qwen OAuth" }
    ]},
    { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" }
    ]},
    { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
      { value: "synthetic-api-key", label: "Synthetic API key" }
    ]},
    { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
      { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
    ]}
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };

    const flag = map[payload.authChoice];

    // If the user picked an API-key auth choice but didn't provide a secret, fail fast.
    // Otherwise OpenClaw may fall back to its default auth choice, which looks like the
    // wizard "reverted" their selection.
    if (flag && !secret) {
      throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    }

    if (flag) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token") {
      // This is the Anthropic setup-token flow.
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  const timeoutMs = opts.timeout ?? 30_000;
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => { if (!resolved) { resolved = true; clearTimeout(timer); resolve(result); } };

    const spawnOpts = {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    };
    // Only pass through safe opts (not 'timeout' which isn't a spawn option)
    if (opts.stdio) spawnOpts.stdio = opts.stdio;
    if (opts.cwd) spawnOpts.cwd = opts.cwd;

    const proc = childProcess.spawn(cmd, args, spawnOpts);

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      finish({ code: 127, output: out });
    });

    proc.on("close", (code) => finish({ code: code ?? 0, output: out }));

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
      out += `\n[timeout] command killed after ${timeoutMs}ms\n`;
      finish({ code: 124, output: out });
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Provider auto-registration
// ---------------------------------------------------------------------------
// OpenClaw's `onboard` only configures the ONE provider the user picks in the
// wizard.  But users often set multiple API keys in Railway env vars.  This
// map lets us detect every available key and register the corresponding
// provider so OpenClaw can route to it.
//
// Format: ENV_VAR_NAME → { providerId, apiKeyRef, models[] }
// `apiKeyRef` uses the ${VAR} syntax so OpenClaw resolves it at runtime rather
// than baking the secret into the JSON config file.
const PROVIDER_REGISTRY = {
  ANTHROPIC_API_KEY: {
    providerId: "anthropic",
    apiKeyRef: "${ANTHROPIC_API_KEY}",
    models: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  OPENAI_API_KEY: {
    providerId: "openai",
    apiKeyRef: "${OPENAI_API_KEY}",
    models: [
      { id: "gpt-4.1", name: "GPT-4.1" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "gpt-4.1-nano", name: "GPT-4.1 Nano" },
    ],
  },
  DEEPSEEK_API_KEY: {
    providerId: "deepseek",
    apiKeyRef: "${DEEPSEEK_API_KEY}",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat (V3)" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)" },
    ],
  },
  GROK_API_KEY: {
    providerId: "xai",
    apiKeyRef: "${GROK_API_KEY}",
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions",
    models: [
      { id: "grok-3", name: "Grok 3" },
      { id: "grok-3-mini", name: "Grok 3 Mini" },
    ],
  },
  KIMI_API_KEY: {
    providerId: "moonshot",
    apiKeyRef: "${KIMI_API_KEY}",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: [
      { id: "kimi-k2-0711", name: "Kimi K2" },
    ],
  },
};

/**
 * Detect all API keys present in the environment and register their providers
 * with OpenClaw.  Uses `models.mode: merge` so each registration adds to
 * (rather than replaces) the existing provider list.
 *
 * @param {string} primaryAuthProvider - the providerId that onboard already configured
 * @returns {Promise<{registered: string[], log: string}>}
 */
async function registerDetectedProviders(primaryAuthProvider) {
  const registered = [];
  let log = "";

  // Ensure merge mode so we don't clobber the primary provider.
  await runCmd(getOpenClawNode(), clawArgs(["config", "set", "models.mode", "merge"]));

  for (const [envVar, entry] of Object.entries(PROVIDER_REGISTRY)) {
    const keyValue = process.env[envVar]?.trim();
    if (!keyValue) continue;

    // Skip if this is the provider that onboard already configured.
    if (entry.providerId === primaryAuthProvider) {
      log += `\n[providers] ${entry.providerId}: skipped (already primary)`;
      continue;
    }

    const providerCfg = {
      apiKey: entry.apiKeyRef,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.api ? { api: entry.api } : {}),
      models: entry.models,
    };

    const result = await runCmd(
      getOpenClawNode(),
      clawArgs(["config", "set", "--json", `models.providers.${entry.providerId}`, JSON.stringify(providerCfg)]),
    );

    if (result.code === 0) {
      registered.push(entry.providerId);
      log += `\n[providers] ${entry.providerId}: registered (${envVar} detected)`;
    } else {
      log += `\n[providers] ${entry.providerId}: FAILED (exit ${result.code}) ${result.output.slice(0, 200)}`;
    }
  }

  return { registered, log };
}

// ---------------------------------------------------------------------------
// Model selection helpers
// ---------------------------------------------------------------------------

/**
 * Map an authChoice value back to a providerId so we can skip re-registering it.
 */
function authChoiceToProviderId(authChoice) {
  const map = {
    "openrouter-api-key": "openrouter",
    "openai-api-key": "openai",
    "openai-codex": "openai",
    "codex-cli": "openai",
    "apiKey": "anthropic",
    "token": "anthropic",
    "claude-cli": "anthropic",
    "gemini-api-key": "google",
    "google-antigravity": "google",
    "google-gemini-cli": "google",
    "moonshot-api-key": "moonshot",
    "kimi-code-api-key": "moonshot",
  };
  return map[authChoice] || "";
}

/**
 * Pick the primary orchestration model — the "brain" that understands tasks
 * and delegates.  Must be cheap enough to never hit rate limits.
 */
function pickPrimaryModel(authChoice) {
  if (authChoice === "openrouter-api-key") return "openrouter/minimax/minimax-m2.5";
  if (authChoice === "openai-api-key") return "openai/gpt-4.1";
  if (authChoice === "openai-codex" || authChoice === "codex-cli") return "openai-codex/gpt-5.3-codex";
  if (authChoice === "apiKey" || authChoice === "token" || authChoice === "claude-cli") return "anthropic/claude-sonnet-4-5";
  if (authChoice === "gemini-api-key" || authChoice === "google-antigravity" || authChoice === "google-gemini-cli") return "gemini/gemini-2.5-pro";
  return undefined;
}

/**
 * Pick the coding subagent model — the "muscle" for writing/reviewing code.
 * Prefers Anthropic direct when available (prompt caching, Max subscription).
 */
function pickSubagentModel(authChoice, registeredProviders) {
  // If Anthropic was registered (directly or as secondary), always prefer it for coding.
  if (registeredProviders.includes("anthropic")) return "anthropic/claude-opus-4-6";
  if (authChoice === "apiKey" || authChoice === "token" || authChoice === "claude-cli") return "anthropic/claude-opus-4-6";
  // OpenRouter fallback — still routes to Opus but through OR
  if (authChoice === "openrouter-api-key") return "openrouter/anthropic/claude-opus-4.6";
  if (authChoice === "openai-codex" || authChoice === "codex-cli") return "openai-codex/gpt-5.3-codex";
  if (authChoice === "openai-api-key") return "openai/gpt-4.1";
  if (authChoice === "gemini-api-key" || authChoice === "google-antigravity" || authChoice === "google-gemini-cli") return "gemini/gemini-2.5-pro";
  return undefined;
}

/**
 * Pick the heartbeat/cron model with fallback chain.
 * Returns an array — primary + 3 fallbacks — for providers that support fallback chains.
 * For providers that don't, returns just the primary as a string.
 */
function pickHeartbeatModels(authChoice) {
  if (authChoice === "openrouter-api-key") {
    // Free-tier models via OpenRouter, ordered by reliability.
    return [
      "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",   // NVIDIA-backed, 256K ctx
      "openrouter/stepfun/step-3.5-flash:free",            // StepFun, 256K ctx, fast
      "openrouter/upstage/solar-pro-3:free",               // Upstage, 128K ctx
      "openrouter/arcee-ai/trinity-mini:free",             // Arcee, 131K ctx
    ];
  }
  if (authChoice === "openai-api-key" || authChoice === "openai-codex" || authChoice === "codex-cli") return ["openai/gpt-4.1-nano"];
  if (authChoice === "apiKey" || authChoice === "token" || authChoice === "claude-cli") return ["anthropic/claude-haiku-4-5"];
  if (authChoice === "gemini-api-key" || authChoice === "google-antigravity" || authChoice === "google-gemini-cli") return ["gemini/gemini-2.5-flash"];
  return ["openrouter/nvidia/nemotron-3-nano-30b-a3b:free"];
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};

    let onboardArgs;
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return res.status(400).json({ ok: false, output: `Setup input error: ${String(err)}` });
    }

    const onboard = await runCmd(getOpenClawNode(), clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional setup (only after successful onboarding).
  if (ok) {
    // Ensure gateway token is written into config so the browser UI can authenticate reliably.
    // (We also enforce loopback bind since the wrapper proxies externally.)
    // IMPORTANT: Set both gateway.auth.token (server-side) and gateway.remote.token (client-side)
    // to the same value so the Control UI can connect without "token mismatch" errors.
    await runCmd(getOpenClawNode(), clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(getOpenClawNode(), clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(getOpenClawNode(), clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
    // NOTE: Do NOT persist gateway.bind or gateway.port to the config file — they are
    // managed exclusively via CLI args in startGateway(). Persisting them can cause
    // schema-validation errors when OpenClaw upgrades change the config schema.
    // await runCmd(getOpenClawNode(), clawArgs(["config", "set", "gateway.bind", "loopback"]));
    // await runCmd(getOpenClawNode(), clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    // Copy default workspace files (AGENTS.md, skills/) if not already present.
    const defaultWorkspaceDir = path.join(process.cwd(), "workspace");
    function copyDefaultsRecursive(srcDir, destDir, prefix = "") {
      try {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(srcDir, entry.name);
          const destPath = path.join(destDir, entry.name);
          const label = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyDefaultsRecursive(srcPath, destPath, label);
          } else if (!fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            extra += `\n[workspace] copied default ${label}`;
          }
        }
      } catch {
        // source dir may not exist
      }
    }
    copyDefaultsRecursive(defaultWorkspaceDir, WORKSPACE_DIR);

    // -----------------------------------------------------------------------
    // Multi-provider auto-registration
    // -----------------------------------------------------------------------
    // Onboard only configures one provider.  Detect ALL API keys the user
    // has set in Railway env vars and register the corresponding providers
    // so OpenClaw can route to any of them.
    const authChoice = payload.authChoice || "";
    const primaryProviderId = authChoiceToProviderId(authChoice);

    const { registered: registeredProviders, log: providerLog } =
      await registerDetectedProviders(primaryProviderId);
    extra += providerLog;

    // -----------------------------------------------------------------------
    // Model selection
    // -----------------------------------------------------------------------
    const primaryModel = pickPrimaryModel(authChoice);
    const subagentModel = pickSubagentModel(authChoice, registeredProviders);
    const heartbeatModels = pickHeartbeatModels(authChoice);

    // Set the primary orchestration model.
    if (primaryModel) {
      await runCmd(getOpenClawNode(), clawArgs(["config", "set", "agents.defaults.model", primaryModel]));
      extra += `\n[models] primary orchestration: ${primaryModel}`;
    }

    // -----------------------------------------------------------------------
    // Cost-optimized defaults
    // -----------------------------------------------------------------------
    const heartbeatCfg = {
      model: heartbeatModels[0],
      // Fallback chain: if the primary heartbeat model is down, try the next.
      ...(heartbeatModels.length > 1 ? { fallbacks: heartbeatModels.slice(1) } : {}),
      every: "30m",
      activeHours: { start: "06:00", end: "23:00", timezone: "UTC" },
    };

    const costDefaults = {
      heartbeat: heartbeatCfg,
      contextPruning: {
        mode: "cache-ttl",
        ttl: "6h",
        keepLastAssistants: 3,
      },
      compaction: {
        mode: "default",
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 40000,
        },
      },
      memorySearch: {
        // Use OpenAI embeddings if available, otherwise skip (OpenClaw handles gracefully).
        provider: "openai",
        model: "text-embedding-3-small",
        sources: ["memory", "sessions"],
      },
      maxConcurrent: 4,
      subagents: {
        maxConcurrent: 8,
        ...(subagentModel ? { model: subagentModel } : {}),
      },
    };
    for (const [key, val] of Object.entries(costDefaults)) {
      const configKey = key === "maxConcurrent" || key === "subagents" || key === "heartbeat"
        ? `agents.defaults.${key}`
        : `agents.defaults.${key}`;
      await runCmd(getOpenClawNode(), clawArgs(["config", "set", "--json", configKey, JSON.stringify(val)]));
    }
    const isAnthropicDirect = subagentModel?.startsWith("anthropic/");
    if (subagentModel) extra += `\n[models] coding subagent: ${subagentModel}${isAnthropicDirect ? " (direct — prompt caching + Max subscription)" : ""}`;
    extra += `\n[models] heartbeat: ${heartbeatModels[0]} + ${heartbeatModels.length - 1} fallbacks`;
    extra += `\n[cost] applied cost-optimized defaults (context pruning, memory compaction, concurrency limits)`;

    // Auto-configure webhook hooks for n8n bridge when OPENCLAW_HOOKS_TOKEN is set.
    if (OPENCLAW_HOOKS_TOKEN) {
      const hooksCfg = {
        enabled: true,
        token: OPENCLAW_HOOKS_TOKEN,
        path: "/hooks",
        allowedAgentIds: ["hooks", "main"],
        defaultSessionKey: "hook:ingress",
      };
      const hooksSet = await runCmd(
        getOpenClawNode(),
        clawArgs(["config", "set", "--json", "hooks", JSON.stringify(hooksCfg)]),
      );
      extra += `\n[hooks] exit=${hooksSet.code} (webhook bridge ${hooksSet.code === 0 ? "enabled" : "failed"})\n${hooksSet.output || "(no output)"}`;
      if (N8N_WEBHOOK_URL) {
        extra += `\n[hooks] n8n reachable at ${N8N_WEBHOOK_URL}`;
      }
    }

    // Optional: configure a custom OpenAI-compatible provider (base URL) for advanced users.
    if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
      const providerId = payload.customProviderId.trim();
      const baseUrl = payload.customProviderBaseUrl.trim();
      const api = (payload.customProviderApi || "openai-completions").trim();
      const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
      const modelId = (payload.customProviderModelId || "").trim();

      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
        extra += `\n[custom provider] skipped: invalid provider id (use letters/numbers/_/-)`;
      } else if (!/^https?:\/\//.test(baseUrl)) {
        extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
      } else if (api !== "openai-completions" && api !== "openai-responses") {
        extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
      } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
        extra += `\n[custom provider] skipped: invalid api key env var name`;
      } else {
        const providerCfg = {
          baseUrl,
          api,
          apiKey: apiKeyEnv ? "${" + apiKeyEnv + "}" : undefined,
          models: modelId ? [{ id: modelId, name: modelId }] : undefined,
        };

        // Ensure we merge in this provider rather than replacing other providers.
        await runCmd(getOpenClawNode(), clawArgs(["config", "set", "models.mode", "merge"]));
        const set = await runCmd(
          getOpenClawNode(),
          clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]),
        );
        extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
      }
    }

    const channelsHelp = await runCmd(getOpenClawNode(), clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          getOpenClawNode(),
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(getOpenClawNode(), clawArgs(["config", "get", "channels.telegram"]));
        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          getOpenClawNode(),
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(getOpenClawNode(), clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          getOpenClawNode(),
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(getOpenClawNode(), clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();
  }

  if (ok) trackEvent("setup_completed", { flow: payload.flow || "quickstart", authChoice: payload.authChoice });

  return res.status(ok ? 200 : 500).json({
    ok,
    output: redactSecrets(`${onboard.output}${extra}`),
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(getOpenClawNode(), clawArgs(["--version"]));
  const help = await runCmd(getOpenClawNode(), clawArgs(["channels", "add", "--help"]));

  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(),
      configPathResolved: configPath(),
      configPathCandidates: typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : null,
      internalGatewayHost: INTERNAL_GATEWAY_HOST,
      internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET,
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError,
      lastGatewayExit,
      lastDoctorAt,
      lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      convexEnabled: Boolean(CONVEX_URL),
    },
    openclaw: {
      entry: getOpenClawEntry(),
      node: getOpenClawNode(),
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Best-effort redaction for common secret formats.
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")           // OpenAI / Anthropic API keys
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")            // GitHub OAuth tokens
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")     // Slack bot/app tokens
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]")     // Generic long secrets
    .replace(/(\d{8,}:[A-Za-z0-9_-]{30,})/g, "[REDACTED]")        // Telegram bot tokens (123456789:AABBcc...)
    .replace(/(M[A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/g, "[REDACTED]")  // Discord bot tokens
    .replace(/(xai-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")           // xAI/Grok API keys
    .replace(/(dsk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]");          // DeepSeek API keys
}

function extractDeviceRequestIds(text) {
  const s = String(text || "");
  const out = new Set();

  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);

  return Array.from(out);
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",

  // Device management (for fixing "disconnected (1008): pairing required")
  "openclaw.devices.list",
  "openclaw.devices.approve",

  // Plugin management
  "openclaw.plugins.list",
  "openclaw.plugins.enable",
  "claude.usage",

  // Hot update
  "openclaw.update",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(getOpenClawNode(), clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(getOpenClawNode(), clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(getOpenClawNode(), clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(getOpenClawNode(), clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(getOpenClawNode(), clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(getOpenClawNode(), clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Device management commands (for fixing "disconnected (1008): pairing required")
    if (cmd === "openclaw.devices.list") {
      const r = await runCmd(getOpenClawNode(), clawArgs(["devices", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.devices.approve") {
      const requestId = String(arg || "").trim();
      if (!requestId) {
        return res.status(400).json({ ok: false, error: "Missing device request ID" });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
        return res.status(400).json({ ok: false, error: "Invalid device request ID" });
      }
      const r = await runCmd(getOpenClawNode(), clawArgs(["devices", "approve", requestId]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Plugin management commands
    if (cmd === "openclaw.plugins.list") {
      const r = await runCmd(getOpenClawNode(), clawArgs(["plugins", "list"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.plugins.enable") {
      const name = String(arg || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "Missing plugin name" });
      if (!/^[A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ ok: false, error: "Invalid plugin name" });
      const r = await runCmd(getOpenClawNode(), clawArgs(["plugins", "enable", name]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // Claude CLI usage check (tries multiple command shapes for compatibility).
    if (cmd === "claude.usage") {
      const attempts = [
        ["usage"],
        ["usage", "--json"],
        ["billing", "usage"],
        ["billing", "usage", "--json"],
      ];

      let lastOutput = "";
      for (const args of attempts) {
        const r = await runCmd("claude", args);
        lastOutput = r.output || lastOutput;
        if (r.code === 0) {
          const label = `$ claude ${args.join(" ")}`;
          const body = (r.output || "").trim() || "(no output)";
          return res.json({ ok: true, output: `${label}\n${redactSecrets(body)}\n` });
        }
      }

      const help = await runCmd("claude", ["--help"]);
      const out = [
        "Claude CLI usage check failed.",
        "Tried: claude usage, claude usage --json, claude billing usage, claude billing usage --json",
        "",
        "Last command output:",
        redactSecrets((lastOutput || "(no output)").trim()),
        "",
        "claude --help:",
        redactSecrets((help.output || "(no output)").trim()),
      ].join("\n");
      return res.status(500).json({ ok: false, output: out });
    }

    // Hot update: pull + build OpenClaw to /data/openclaw, then restart gateway
    if (cmd === "openclaw.update") {
      const ref = arg || "main";
      if (!/^[A-Za-z0-9_./-]+$/.test(ref) && !/^--(?:stable|beta|canary)$/.test(ref)) {
        return res.status(400).json({ ok: false, error: "Invalid ref (use --stable, --beta, --canary, or a branch/tag/SHA)" });
      }
      const r = await runCmd("/bin/bash", ["/app/scripts/update-openclaw.sh", ref], { timeout: 600_000 });
      if (r.code === 0) {
        process.env.OPENCLAW_ENTRY = "/data/openclaw/dist/entry.js";
        resetCrashCounter();
        await restartGateway();
        return res.json({ ok: true, output: redactSecrets(r.output) + "\nGateway restarted with updated OpenClaw.\n" });
      }
      return res.status(500).json({ ok: false, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    atomicWriteFile(p, content);

    // Config save exits safe mode.
    resetCrashCounter();

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(getOpenClawNode(), clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

// Device pairing helper (list + approve) to avoid needing SSH.
app.get("/setup/api/devices/pending", requireSetupAuth, async (_req, res) => {
  const r = await runCmd(getOpenClawNode(), clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, requestIds, output });
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const requestId = String((req.body && req.body.requestId) || "").trim();
  if (!requestId) return res.status(400).json({ ok: false, error: "Missing device request ID" });
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) return res.status(400).json({ ok: false, error: "Invalid device request ID" });
  const r = await runCmd(getOpenClawNode(), clawArgs(["devices", "approve", requestId]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    const candidates = typeof resolveConfigCandidates === "function" ? resolveConfigCandidates() : [configPath()];
    for (const p of candidates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }
    res.type("text/plain").send("OK - deleted config file(s). You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// ---------------------------------------------------------------------------
// Convex Workflow API (guarded — all endpoints no-op when CONVEX_URL is unset)
// ---------------------------------------------------------------------------

app.get("/setup/api/workflows/status", requireSetupAuth, async (_req, res) => {
  res.json({
    enabled: Boolean(CONVEX_URL),
    convexUrl: CONVEX_URL ? "(set)" : "(not set)",
  });
});

app.post("/setup/api/workflows/agent-task", requireSetupAuth, async (req, res) => {
  const client = createConvexClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: "Convex not configured (CONVEX_URL not set)" });
  }

  try {
    const { taskDescription, agentId, models, maxRetries } = req.body || {};
    if (!taskDescription) {
      return res.status(400).json({ ok: false, error: "Missing taskDescription" });
    }

    // ConvexHttpClient requires the function reference as a string path.
    const workflowId = await client.mutation("openclawApi:startAgentTask", {
      secret: CONVEX_SECRET,
      taskDescription,
      agentId: agentId || undefined,
      models: Array.isArray(models) ? models : undefined,
      maxRetries: maxRetries != null ? Number(maxRetries) : undefined,
    });

    trackEvent("workflow_started", { type: "agentTask", workflowId });
    return res.json({ ok: true, workflowId });
  } catch (err) {
    console.error("[workflows/agent-task]", redactSecrets(String(err)));
    return res.status(500).json({ ok: false, error: redactSecrets(String(err)) });
  }
});

app.post("/setup/api/workflows/heartbeat", requireSetupAuth, async (req, res) => {
  const client = createConvexClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: "Convex not configured (CONVEX_URL not set)" });
  }

  try {
    const { pingModel } = req.body || {};
    // Use the public-facing URL so Convex (running externally) can reach the
    // gateway. GATEWAY_TARGET is 127.0.0.1 and only valid inside this container.
    const rawPublicUrl = process.env.OPENCLAW_PUBLIC_URL?.trim() || process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || "";
    // Strip existing protocol to avoid double-prefix (e.g. https://https://...)
    const publicGatewayUrl = rawPublicUrl
      ? (rawPublicUrl.startsWith("http") ? rawPublicUrl : `https://${rawPublicUrl}`)
      : "";
    const workflowId = await client.mutation("openclawApi:startHeartbeat", {
      secret: CONVEX_SECRET,
      gatewayUrl: publicGatewayUrl,
      gatewayToken: OPENCLAW_GATEWAY_TOKEN || undefined,
      pingModel: pingModel || undefined,
    });

    trackEvent("workflow_started", { type: "heartbeat", workflowId });
    return res.json({ ok: true, workflowId });
  } catch (err) {
    console.error("[workflows/heartbeat]", redactSecrets(String(err)));
    return res.status(500).json({ ok: false, error: redactSecrets(String(err)) });
  }
});

app.post("/setup/api/workflows/sub-agents", requireSetupAuth, async (req, res) => {
  const client = createConvexClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: "Convex not configured (CONVEX_URL not set)" });
  }

  try {
    const { parentAgentId, tasks } = req.body || {};
    if (!parentAgentId || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing parentAgentId or tasks array" });
    }

    const workflowId = await client.mutation("openclawApi:startSubAgentOrchestration", {
      secret: CONVEX_SECRET,
      parentAgentId,
      tasks,
    });

    trackEvent("workflow_started", { type: "subAgentOrchestration", workflowId });
    return res.json({ ok: true, workflowId });
  } catch (err) {
    console.error("[workflows/sub-agents]", redactSecrets(String(err)));
    return res.status(500).json({ ok: false, error: redactSecrets(String(err)) });
  }
});

app.get("/setup/api/workflows/:workflowId", requireSetupAuth, async (req, res) => {
  const client = createConvexClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: "Convex not configured (CONVEX_URL not set)" });
  }

  try {
    const status = await client.action("openclawApi:getWorkflowStatus", {
      secret: CONVEX_SECRET,
      workflowId: req.params.workflowId,
    });
    return res.json({ ok: true, status });
  } catch (err) {
    console.error("[workflows/status]", redactSecrets(String(err)));
    return res.status(500).json({ ok: false, error: redactSecrets(String(err)) });
  }
});

app.post("/setup/api/workflows/:workflowId/cancel", requireSetupAuth, async (req, res) => {
  const client = createConvexClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: "Convex not configured (CONVEX_URL not set)" });
  }

  try {
    await client.mutation("openclawApi:cancelWorkflow", {
      secret: CONVEX_SECRET,
      workflowId: req.params.workflowId,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[workflows/cancel]", redactSecrets(String(err)));
    return res.status(500).json({ ok: false, error: redactSecrets(String(err)) });
  }
});

app.get("/setup/api/workflows", requireSetupAuth, async (req, res) => {
  const client = createConvexClient();
  if (!client) {
    return res.status(503).json({ ok: false, error: "Convex not configured (CONVEX_URL not set)" });
  }

  try {
    const validTypes = ["agentTask", "heartbeat", "subAgentOrchestration"];
    const rawType = req.query.type || undefined;
    if (rawType && !validTypes.includes(rawType)) {
      return res.status(400).json({ ok: false, error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
    }
    const type = rawType;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const workflows = await client.query("openclawApi:listRecentWorkflows", {
      secret: CONVEX_SECRET,
      type,
      limit,
    });
    return res.json({ ok: true, workflows });
  } catch (err) {
    console.error("[workflows/list]", redactSecrets(String(err)));
    return res.status(500).json({ ok: false, error: redactSecrets(String(err)) });
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      const hint = [
        "Gateway not ready.",
        String(err),
        lastGatewayError ? `\n${lastGatewayError}` : "",
        "\nTroubleshooting:",
        "- Visit /setup and check the Debug Console",
        "- Visit /setup/api/debug for config + gateway diagnostics",
      ].join("\n");
      return res.status(503).type("text/plain").send(hint);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] entry point: ${getOpenClawEntry()}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  console.log(`[wrapper] hooks token: ${OPENCLAW_HOOKS_TOKEN ? "(set)" : "(not set - n8n bridge disabled)"}`);
  console.log(`[wrapper] convex workflows: ${CONVEX_URL ? "(enabled)" : "(not configured - set CONVEX_URL)"}`);
  if (N8N_WEBHOOK_URL) console.log(`[wrapper] n8n webhook url: ${N8N_WEBHOOK_URL}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }

  // Log OpenClaw version for diagnostics.
  // The --version command may also emit config warnings to stderr, so extract just the version line.
  try {
    const versionResult = await runCmd(getOpenClawNode(), clawArgs(["--version"]), { timeout: 10_000 });
    const versionLine = (versionResult.output || "").split("\n").find((l) => /^\d+\.\d+/.test(l.trim()));
    console.log(`[wrapper] openclaw version: ${versionLine?.trim() || versionResult.output.trim().slice(0, 100)}`);
  } catch {
    console.warn("[wrapper] could not determine openclaw version");
  }

  // Auto-configure webhook hooks for n8n bridge on boot (idempotent).
  if (isConfigured() && OPENCLAW_HOOKS_TOKEN) {
    console.log("[wrapper] configuring webhook hooks for n8n bridge...");
    try {
      const hooksCfg = {
        enabled: true,
        token: OPENCLAW_HOOKS_TOKEN,
        path: "/hooks",
        allowedAgentIds: ["hooks", "main"],
        defaultSessionKey: "hook:ingress",
      };
      await runCmd(
        getOpenClawNode(),
        clawArgs(["config", "set", "--json", "hooks", JSON.stringify(hooksCfg)]),
      );
      console.log("[wrapper] webhook hooks configured");
      if (N8N_WEBHOOK_URL) {
        console.log(`[wrapper] n8n endpoint: ${N8N_WEBHOOK_URL}`);
      }
    } catch (err) {
      console.error(`[wrapper] hooks config failed: ${String(err)}`);
    }
  }

  // Auto-start the gateway if already configured so polling channels (Telegram/Discord/etc.)
  // work even if nobody visits the web UI.
  if (isConfigured()) {
    await cleanupStaleConfigKeys();
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
      trackEvent("gateway_started");

      // Auto-approve any pending device pairing requests so the wrapper proxy
      // and remote clients can connect without manual intervention.
      try {
        const devList = await runCmd(getOpenClawNode(), clawArgs(["devices", "list", "--json"]));
        if (devList.code === 0 && devList.output.trim()) {
          try {
            const devices = JSON.parse(devList.output);
            const pending = (Array.isArray(devices) ? devices : devices?.devices || [])
              .filter((d) => d.status === "pending" || d.state === "pending");
            for (const d of pending) {
              const id = d.requestId || d.id;
              if (id) {
                const r = await runCmd(getOpenClawNode(), clawArgs(["devices", "approve", id]));
                console.log(`[wrapper] auto-approved device ${id} (exit=${r.code})`);
              }
            }
          } catch {
            // JSON parse failed — devices list may not support --json, ignore
          }
        }
      } catch {
        // best effort
      }
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[wrapper] received ${signal}, shutting down gracefully...`);

  // 1. Stop accepting new HTTP connections
  const serverClosePromise = new Promise((resolve) => {
    server.close(resolve);
    if (server.closeIdleConnections) server.closeIdleConnections();
  });

  // 2. Stop gateway child (wait up to 5s, then force kill)
  if (gatewayProc) {
    try { gatewayProc.kill("SIGTERM"); } catch {}
    await Promise.race([
      new Promise((resolve) => { gatewayProc?.on("exit", resolve); }),
      sleep(5000),
    ]);
    if (gatewayProc) {
      try { gatewayProc.kill("SIGKILL"); } catch {}
    }
  }

  // 3. Flush analytics
  try { if (posthog) await posthog.shutdown(); } catch {}

  // 4. Drain HTTP (max 3s)
  await Promise.race([serverClosePromise, sleep(3000)]);

  console.log("[wrapper] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
