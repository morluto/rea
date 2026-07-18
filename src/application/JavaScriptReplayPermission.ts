import type { z } from "zod";

import type { controlledReplayInputSchema } from "../domain/javascriptReplay.js";
import type { JavaScriptReplayPolicy } from "./JavaScriptReplayPlanning.js";

/** Build the exact permission request for one controlled replay operation. */
export const replayPermissionRequest = (
  input: z.output<typeof controlledReplayInputSchema>,
  policy: JavaScriptReplayPolicy,
) => ({
  capability: "javascript_replay" as const,
  roots: [...input.left.modules, ...(input.right?.modules ?? [])].map(
    ({ path }) => path,
  ),
  executables: [
    policy.nodePath,
    policy.bubblewrapPath,
    policy.systemdRunPath,
    policy.systemctlPath,
    policy.shellPath,
  ],
  environment_names: [],
  network: "none" as const,
  mount: true,
  operation_identity: `run_controlled_replay:${input.plan_digest ?? "plan"}`,
});
