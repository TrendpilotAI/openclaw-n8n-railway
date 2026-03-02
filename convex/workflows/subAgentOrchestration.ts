/**
 * Sub-agent orchestration workflow.
 *
 * Spawns multiple agent tasks in parallel (via Promise.all on workflow steps),
 * collects their results, and returns a merged summary. This is the Convex
 * equivalent of OpenClaw's concurrent sub-agent execution but with durable
 * replay guarantees.
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import { workflow } from "../index";

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export const subAgentOrchestrationWorkflow = workflow.define({
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
  returns: v.object({
    totalTasks: v.number(),
    completed: v.number(),
    failed: v.number(),
    results: v.array(
      v.object({
        agentId: v.string(),
        status: v.string(),
        output: v.optional(v.string()),
      }),
    ),
    durationMs: v.number(),
  }),
  handler: async (step, args) => {
    const startMs = Date.now();

    // Step 1: Record orchestration start.
    await step.runMutation(
      internal.workflows.subAgentOrchestration.recordOrchestrationStart,
      {
        workflowId: step.workflowId,
        parentAgentId: args.parentAgentId,
        taskCount: args.tasks.length,
      },
    );

    // Step 2: Execute all sub-agent tasks in parallel.
    // Convex workflows block until all Promise.all steps complete.
    const results = await Promise.all(
      args.tasks.map((task) =>
        step.runAction(
          internal.workflows.subAgentOrchestration.executeSubAgent,
          {
            taskDescription: task.taskDescription,
            agentId: task.agentId,
            models: task.models ?? [],
          },
        ),
      ),
    );

    const completed = results.filter((r) => r.status === "completed").length;
    const failed = results.filter((r) => r.status === "failed").length;

    // Step 3: Record orchestration result.
    await step.runMutation(
      internal.workflows.subAgentOrchestration.recordOrchestrationResult,
      {
        workflowId: step.workflowId,
        completed,
        failed,
        totalTasks: args.tasks.length,
      },
    );

    return {
      totalTasks: args.tasks.length,
      completed,
      failed,
      results,
      durationMs: Date.now() - startMs,
    };
  },
});

// ---------------------------------------------------------------------------
// Supporting functions
// ---------------------------------------------------------------------------

export const executeSubAgent = internalAction({
  args: {
    taskDescription: v.string(),
    agentId: v.string(),
    models: v.array(v.string()),
  },
  handler: async (_ctx, args) => {
    // TODO: Wire to OpenClaw gateway internal API for actual LLM execution.
    // For now, stub that simulates sub-agent completion.
    console.log(
      `[subAgent] executing task="${args.taskDescription}" agent=${args.agentId}`,
    );

    return {
      agentId: args.agentId,
      status: "completed" as const,
      output: `Sub-agent ${args.agentId} completed: ${args.taskDescription}`,
    };
  },
});

export const recordOrchestrationStart = internalMutation({
  args: {
    workflowId: v.string(),
    parentAgentId: v.string(),
    taskCount: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("openclawWorkflows", {
      type: "subAgentOrchestration",
      workflowId: args.workflowId,
      context: {
        parentAgentId: args.parentAgentId,
        taskCount: args.taskCount,
      },
      startedAt: Date.now(),
    });
  },
});

export const recordOrchestrationResult = internalMutation({
  args: {
    workflowId: v.string(),
    completed: v.number(),
    failed: v.number(),
    totalTasks: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("openclawWorkflows")
      .withIndex("by_workflow_id", (q) => q.eq("workflowId", args.workflowId))
      .first();

    if (existing) {
      const allPassed = args.failed === 0;
      await ctx.db.patch(existing._id, {
        result: {
          kind: allPassed ? "success" as const : "error" as const,
          ...(allPassed
            ? { returnValue: { completed: args.completed, totalTasks: args.totalTasks } }
            : { error: `${args.failed}/${args.totalTasks} sub-agents failed` }),
        },
        completedAt: Date.now(),
      });
    }
  },
});
