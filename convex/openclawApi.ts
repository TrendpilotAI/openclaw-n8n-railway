/**
 * Public Convex functions exposed to the Express server via ConvexHttpClient.
 *
 * ConvexHttpClient cannot call internal functions, so these thin wrappers
 * start workflows and query status from the external OpenClaw server.
 */
import { v } from "convex/values";
import { mutation, action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { workflow } from "./index";

// ---------------------------------------------------------------------------
// Start workflows
// ---------------------------------------------------------------------------

export const startAgentTask = mutation({
  args: {
    taskDescription: v.string(),
    agentId: v.optional(v.string()),
    models: v.optional(v.array(v.string())),
    maxRetries: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
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
    gatewayUrl: v.optional(v.string()),
    pingModel: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const workflowId = await workflow.start(
      ctx,
      internal.workflows.heartbeat.heartbeatWorkflow,
      {
        gatewayUrl: args.gatewayUrl,
        pingModel: args.pingModel,
      },
    );
    return workflowId;
  },
});

export const startSubAgentOrchestration = mutation({
  args: {
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
  args: { workflowId: v.string() },
  handler: async (ctx, args) => {
    return await workflow.status(ctx, args.workflowId);
  },
});

export const cancelWorkflow = mutation({
  args: { workflowId: v.string() },
  handler: async (ctx, args) => {
    await workflow.cancel(ctx, args.workflowId);
  },
});

export const cleanupWorkflow = mutation({
  args: { workflowId: v.string() },
  handler: async (ctx, args) => {
    await workflow.cleanup(ctx, args.workflowId);
  },
});

// ---------------------------------------------------------------------------
// Query recent workflows (for observability)
// ---------------------------------------------------------------------------

export const listRecentWorkflows = query({
  args: {
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
    const limit = args.limit ?? 20;

    if (args.type) {
      return await ctx.db
        .query("openclawWorkflows")
        .withIndex("by_type", (q) => q.eq("type", args.type!))
        .order("desc")
        .take(limit);
    }

    return await ctx.db
      .query("openclawWorkflows")
      .order("desc")
      .take(limit);
  },
});
