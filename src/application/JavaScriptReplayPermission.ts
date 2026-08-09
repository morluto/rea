import type { ControlledReplayInput } from "../domain/javascriptReplay.js";
import type { EnabledJavaScriptReplayPolicy } from "./JavaScriptReplayPlanning.js";

/** Build the exact permission request for one controlled replay operation. */
export const replayPermissionRequest = (
  input: ControlledReplayInput,
  policy: EnabledJavaScriptReplayPolicy,
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
  operation_identity: `run_controlled_replay:${input.mode === "plan" ? "plan" : input.plan_digest}`,
});
