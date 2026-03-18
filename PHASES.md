# PR Review Remediation — Phases

## Phase 1: Security — SSRF + Secret Redaction
- **Status**: complete
- **Scope**:
  1. Remove `gatewayUrl` from caller-supplied args; read from Convex env instead
  2. Make `requireSecret()` fail-closed (no dev bypass)
  3. Add `redactSecrets()` to Convex workflow logs/outputs
  4. Remove gateway URL/token from server.js workflow calls
- **Files modified**: `convex/openclawApi.ts`, `convex/workflows/agentTask.ts`, `convex/workflows/subAgentOrchestration.ts`, `src/server.js`

## Phase 2: Correctness — Connect Script + maxRetries
- **Status**: complete
- **Scope**:
  1. Fix connect script env-ref literal detection (try printenv first, detect `${...}` patterns)
  2. Implement `maxRetries` with exponential backoff in `executeLlmCall`
- **Files modified**: `scripts/connect-mac-to-railway-gateway.sh`, `convex/workflows/agentTask.ts`

## Phase 3: Quality — Metrics + log() + Docs
- **Status**: complete
- **Scope**:
  1. Fix quality-metrics.json thresholds (added `max_missing_docs`, `max_todo_count`)
  2. Add quality report generation script + gitignore the committed snapshot
  3. Fix `log()` in update-openclaw.sh to write to stderr + revert ad-hoc echo calls
  4. Document that Convex `.ts` is exempt from no-TypeScript rule in CLAUDE.md
- **Files modified**: `quality-reports/quality-metrics.json`, `scripts/generate-quality-report.js`, `scripts/update-openclaw.sh`, `package.json`, `.gitignore`, `CLAUDE.md`
