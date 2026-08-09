import type {
  EnabledJavaScriptReplayPolicy,
  JavaScriptReplayPolicy,
} from "../application/JavaScriptReplayPlanning.js";
import { ConfigurationError } from "../domain/errors.js";
import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Environment } from "./environment.js";
import { parseAbsoluteRoots } from "./parsers.js";
import { permissionScope } from "./permissions.js";

/** Parse controlled replay configuration into disabled or fully enabled state. */
export const parseJavaScriptReplayPolicy = (
  env: Environment,
): Result<JavaScriptReplayPolicy, ConfigurationError> => {
  const roots = parseAbsoluteRoots(
    env.REA_JAVASCRIPT_REPLAY_ROOTS_JSON,
    "REA_JAVASCRIPT_REPLAY_ROOTS_JSON",
  );
  if (!roots.ok) return roots;
  if (env.REA_JAVASCRIPT_REPLAY_ENABLED !== "true")
    return ok({ status: "disabled" });
  const [firstRoot, ...remainingRoots] = roots.value;
  if (firstRoot === undefined)
    return err(
      new ConfigurationError(
        "REA_JAVASCRIPT_REPLAY_ROOTS_JSON must encode at least one absolute root when JavaScript replay is enabled",
      ),
    );
  return ok({
    status: "enabled",
    roots: [firstRoot, ...remainingRoots],
    nodePath: env.REA_JAVASCRIPT_REPLAY_NODE_PATH,
    bubblewrapPath: env.REA_JAVASCRIPT_REPLAY_BWRAP_PATH,
    systemdRunPath: env.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH,
    systemctlPath: env.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH,
    shellPath: env.REA_JAVASCRIPT_REPLAY_SHELL_PATH,
  });
};

/** Add the exact controlled replay ceiling when replay is enabled. */
export const appendJavaScriptReplayCeiling = (
  ceilings: PermissionCeiling[],
  policy: JavaScriptReplayPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("javascript_replay", policy.roots, {
      executables: replayExecutables(policy),
      network: "none",
      mount: true,
    }),
  );
};

const replayExecutables = (
  policy: EnabledJavaScriptReplayPolicy,
): readonly string[] => [
  policy.nodePath,
  policy.bubblewrapPath,
  policy.systemdRunPath,
  policy.systemctlPath,
  policy.shellPath,
];
