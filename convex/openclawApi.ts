/**
 * Public Convex functions exposed to the Express server via ConvexHttpClient.
 *
 * ConvexHttpClient cannot call internal functions, so these thin wrappers
 * start workflows and query status from the external OpenClaw server.
 *
 * All public functions require a shared secret (`OPENCLAW_CONVEX_SECRET`) to
 * prevent unauthenticated access if the Convex deployment URL is discovered.
 */
import { v } from "convex/values";
import { mutation, action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { workflow } from "./index";

/**
 * Verify shared secret to prevent unauthenticated access to Convex functions.
 * The secret is set via `OPENCLAW_CONVEX_SECRET` env var in the Convex dashboard
 * and must be passed by the Express server in every call.
 */
function requireSecret(secret: string | undefined) {
  const expected = process.env.OPENCLAW_CONVEX_SECRET;
  if (!expected) {
    // If no secret is configured, allow calls (development mode).
    return;
  }
  if (secret !== expected) {
    throw new Error("Unauthorized: invalid or missing convex secret");
  }
}

// ---------------------------------------------------------------------------
// Start workflows
// ---------------------------------------------------------------------------

export const startAgentTask = mutation({
  args: {
    secret: v.optional(v.string()),
    taskDescription: v.string(),
    agentId: v.optional(v.string()),
    models: v.optional(v.array(v.string())),
    maxRetries: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.agentTask.agentTaskWorkflow,
      {
        taskDescription: args.taskDescription,
        agentId: args.agentId,
        models: args.models,
        maxRetries: args.maxRetries,
      },
    );
    return workflowId;
  },
});

export const startHeartbeat = mutation({
  args: {
    secret: v.optional(v.string()),
    gatewayUrl: v.optional(v.string()),
    gatewayToken: v.optional(v.string()),
    pingModel: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.heartbeat.heartbeatWorkflow,
      {
        gatewayUrl: args.gatewayUrl,
        gatewayToken: args.gatewayToken,
        pingModel: args.pingModel,
      },
    );
    return workflowId;
  },
});

export const startSubAgentOrchestration = mutation({
  args: {
    secret: v.optional(v.string()),
    parentAgentId: v.string(),
    tasks: v.array(
      v.object({
        taskDescription: v.string(),
        agentId: v.string(),
        models: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.subAgentOrchestration.subAgentOrchestrationWorkflow,
      {
        parentAgentId: args.parentAgentId,
        tasks: args.tasks,
      },
    );
    return workflowId;
  },
});

// ---------------------------------------------------------------------------
// Query workflow status
// ---------------------------------------------------------------------------

export const getWorkflowStatus = action({
  args: { secret: v.optional(v.string()), workflowId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    return await workflow.status(ctx, args.workflowId);
  },
});

export const cancelWorkflow = mutation({
  args: { secret: v.optional(v.string()), workflowId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    await workflow.cancel(ctx, args.workflowId);
  },
});

export const cleanupWorkflow = mutation({
  args: { secret: v.optional(v.string()), workflowId: v.string() },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    await workflow.cleanup(ctx, args.workflowId);
  },
});

// ---------------------------------------------------------------------------
// Query recent workflows (for observability)
// ---------------------------------------------------------------------------

export const listRecentWorkflows = query({
  args: {
    secret: v.optional(v.string()),
    type: v.optional(
      v.union(
        v.literal("agentTask"),
        v.literal("heartbeat"),
        v.literal("subAgentOrchestration"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const limit = args.limit ?? 20;

    if (args.type) {
      return await ctx.db
        .query("openclawWorkflows")
        .withIndex("by_type_and_time", (q) => q.eq("type", args.type!))
        .order("desc")
        .take(limit);
    }

    return await ctx.db
      .query("openclawWorkflows")
      .order("desc")
      .take(limit);
  },
});
