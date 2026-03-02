import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // Keep parallelism modest — OpenClaw's own concurrency limits are the
    // primary throttle; this just prevents runaway fan-out inside Convex.
    maxParallelism: 10,
  },
});
