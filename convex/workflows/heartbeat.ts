/**
 * Periodic health-check workflow for OpenClaw.
 *
 * Replaces the cron-based heartbeat with a durable Convex workflow that:
 *   1. Checks the OpenClaw gateway's /healthz endpoint
 *   2. Optionally runs a lightweight LLM ping to verify model routing
 *   3. Records results for observability
 *
 * Schedule this via a Convex cron or trigger it from the Express server.
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { workflow } from "../index";

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export const heartbeatWorkflow = workflow.define({
  args: {
    gatewayUrl: v.optional(v.string()),
    // If provided, sends a tiny completion request to verify model routing.
    pingModel: v.optional(v.string()),
  },
  returns: v.object({
    healthy: v.boolean(),
    gatewayOk: v.boolean(),
    modelPingOk: v.optional(v.boolean()),
    durationMs: v.number(),
  }),
  handler: async (step, args) => {
    const startMs = Date.now();

    // Step 1: Check gateway health.
    const gatewayResult = await step.runAction(
      internal.workflows.heartbeat.checkGateway,
      { gatewayUrl: args.gatewayUrl ?? "" },
    );

    // Step 2: Optional model ping.
    let modelPingOk: boolean | undefined;
    if (args.pingModel) {
      const pingResult = await step.runAction(
        internal.workflows.heartbeat.pingModel,
        {
          gatewayUrl: args.gatewayUrl ?? "",
          model: args.pingModel,
        },
      );
      modelPingOk = pingResult.ok;
    }

    const healthy = gatewayResult.ok && (modelPingOk === undefined || modelPingOk);

    // Step 3: Record heartbeat result.
    await step.runMutation(internal.workflows.heartbeat.recordHeartbeat, {
      workflowId: step.workflowId,
      healthy,
      gatewayOk: gatewayResult.ok,
      modelPingOk,
      durationMs: Date.now() - startMs,
    });

    return {
      healthy,
      gatewayOk: gatewayResult.ok,
      modelPingOk,
      durationMs: Date.now() - startMs,
    };
  },
});

// ---------------------------------------------------------------------------
// Supporting functions
// ---------------------------------------------------------------------------

export const checkGateway = internalAction({
  args: { gatewayUrl: v.string() },
  handler: async (_ctx, args) => {
    if (!args.gatewayUrl) {
      // No gateway URL configured — can't check, assume degraded.
      return { ok: false, error: "No gateway URL configured" };
    }

    try {
      const url = args.gatewayUrl.replace(/\/$/, "") + "/healthz";
      const resp = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      const ok = resp.ok;
      return { ok, error: ok ? undefined : `HTTP ${resp.status}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
});

export const pingModel = internalAction({
  args: {
    gatewayUrl: v.string(),
    model: v.string(),
  },
  handler: async (_ctx, args) => {
    if (!args.gatewayUrl) {
      return { ok: false, error: "No gateway URL" };
    }

    try {
      // Lightweight completion request — just enough to verify routing works.
      const resp = await fetch(
        args.gatewayUrl.replace(/\/$/, "") + "/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: args.model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      return { ok: resp.ok };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
});

export const recordHeartbeat = internalMutation({
  args: {
    workflowId: v.string(),
    healthy: v.boolean(),
    gatewayOk: v.boolean(),
    modelPingOk: v.optional(v.boolean()),
    durationMs: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("openclawWorkflows", {
      type: "heartbeat",
      workflowId: args.workflowId,
      context: {
        healthy: args.healthy,
        gatewayOk: args.gatewayOk,
        modelPingOk: args.modelPingOk,
        durationMs: args.durationMs,
      },
      result: {
        kind: args.healthy ? "success" : "error",
        ...(args.healthy
          ? { returnValue: { durationMs: args.durationMs } }
          : { error: `Gateway: ${args.gatewayOk}, Model: ${args.modelPingOk}` }),
      },
      startedAt: Date.now() - args.durationMs,
      completedAt: Date.now(),
    });
  },
});
