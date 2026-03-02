import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Track OpenClaw workflow executions for observability.
  openclawWorkflows: defineTable({
    type: v.union(
      v.literal("agentTask"),
      v.literal("heartbeat"),
      v.literal("subAgentOrchestration"),
    ),
    // Convex workflow ID returned by workflow.start().
    workflowId: v.string(),
    // Caller-supplied context (agent ID, task description, etc.).
    context: v.optional(v.any()),
    // Terminal state recorded by onComplete callback.
    result: v.optional(
      v.union(
        v.object({ kind: v.literal("success"), returnValue: v.any() }),
        v.object({ kind: v.literal("error"), error: v.string() }),
        v.object({ kind: v.literal("canceled") }),
      ),
    ),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_type_and_time", ["type", "startedAt"])
    .index("by_workflow_id", ["workflowId"]),
});
