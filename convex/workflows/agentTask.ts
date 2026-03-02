/**
 * Durable execution wrapper for OpenClaw LLM agent tasks.
 *
 * Each workflow step is individually retried and journaled by Convex, so a
 * crash mid-task replays from the last completed step rather than restarting
 * from scratch.
 *
 * Note: The 10-minute per-action timeout means long LLM calls should be split
 * into continuation steps (prompt → stream → collect → next prompt).
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { workflow } from "../index";

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export const agentTaskWorkflow = workflow.define({
  args: {
    taskDescription: v.string(),
    agentId: v.optional(v.string()),
    // Model fallback chain — first entry is primary, rest are fallbacks.
    models: v.optional(v.array(v.string())),
    maxRetries: v.optional(v.number()),
  },
  returns: v.object({
    status: v.string(),
    output: v.optional(v.string()),
    model: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  }),
  handler: async (step, args) => {
    const startMs = Date.now();

    // Step 1: Record the task in our tracking table.
    await step.runMutation(internal.workflows.agentTask.recordStart, {
      workflowId: step.workflowId,
      taskDescription: args.taskDescription,
      agentId: args.agentId,
    });

    // Step 2: Execute the LLM call with model fallback.
    const result = await step.runAction(
      internal.workflows.agentTask.executeLlmCall,
      {
        taskDescription: args.taskDescription,
        agentId: args.agentId ?? "default",
        models: args.models ?? [],
        maxRetries: args.maxRetries ?? 2,
      },
    );

    // Step 3: Persist the result.
    await step.runMutation(internal.workflows.agentTask.recordResult, {
      workflowId: step.workflowId,
      status: result.status,
      output: result.output,
      model: result.model,
    });

    return {
      status: result.status,
      output: result.output,
      model: result.model,
      durationMs: Date.now() - startMs,
    };
  },
});

// ---------------------------------------------------------------------------
// Supporting functions (called as workflow steps)
// ---------------------------------------------------------------------------

export const recordStart = internalMutation({
  args: {
    workflowId: v.string(),
    taskDescription: v.string(),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("openclawWorkflows", {
      type: "agentTask",
      workflowId: args.workflowId,
      context: {
        taskDescription: args.taskDescription,
        agentId: args.agentId,
      },
      startedAt: Date.now(),
    });
  },
});

export const executeLlmCall = internalAction({
  args: {
    taskDescription: v.string(),
    agentId: v.string(),
    models: v.array(v.string()),
    maxRetries: v.number(),
  },
  handler: async (_ctx, args) => {
    // This action runs outside the database transaction and can call external
    // APIs. In production this will call the OpenClaw gateway's internal API
    // to execute the actual LLM task. For now it's a placeholder that the
    // server.js integration will drive via the gateway proxy.
    //
    // The model fallback logic works like this:
    //   1. Try models[0]
    //   2. On failure, try models[1], etc.
    //   3. If all fail, return error status.

    const models = args.models.length > 0 ? args.models : ["default"];
    let lastError = "";

    for (const model of models) {
      try {
        // TODO: Replace with actual OpenClaw gateway call once CONVEX_URL is
        // wired and the gateway internal API is accessible from Convex actions.
        // For now, return a success stub so the workflow pipeline is testable.
        console.log(
          `[agentTask] executing task="${args.taskDescription}" agent=${args.agentId} model=${model}`,
        );

        return {
          status: "completed" as const,
          output: `Task "${args.taskDescription}" executed successfully with model ${model}`,
          model,
        };
      } catch (err) {
        lastError = String(err);
        console.warn(
          `[agentTask] model=${model} failed: ${lastError}, trying next fallback...`,
        );
      }
    }

    return {
      status: "failed" as const,
      output: `All models exhausted. Last error: ${lastError}`,
      model: undefined,
    };
  },
});

export const recordResult = internalMutation({
  args: {
    workflowId: v.string(),
    status: v.string(),
    output: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("openclawWorkflows")
      .withIndex("by_workflow_id", (q) => q.eq("workflowId", args.workflowId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        result: {
          kind: args.status === "completed" ? "success" as const : "error" as const,
          ...(args.status === "completed"
            ? { returnValue: { output: args.output, model: args.model } }
            : { error: args.output ?? "Unknown error" }),
        },
        completedAt: Date.now(),
      });
    }
  },
});
