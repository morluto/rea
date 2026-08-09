import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { permissionScope } from "./permissions.js";
import { parseAbsoluteRoots } from "./parsers.js";
import type { Environment } from "./environment.js";

/** Parsed availability and authority scope for active Electron automation. */
export type ElectronAutomationPolicy =
  | { readonly status: "disabled" }
  | {
      readonly status: "enabled";
      readonly executableRoots: readonly [string, ...string[]];
      readonly applicationRoots: readonly [string, ...string[]];
    };

/** Parse active Electron automation into a closed disabled or enabled policy. */
export const parseElectronAutomationPolicy = (
  env: Environment,
): Result<ElectronAutomationPolicy, ConfigurationError> => {
  const executableRoots = parseAbsoluteRoots(
    env.REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON,
    "REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON",
  );
  if (!executableRoots.ok) return executableRoots;
  const applicationRoots = parseAbsoluteRoots(
    env.REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON,
    "REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON",
  );
  if (!applicationRoots.ok) return applicationRoots;
  if (env.REA_ELECTRON_AUTOMATE_ENABLED !== "true")
    return ok({ status: "disabled" });
  const [firstExecutableRoot, ...remainingExecutableRoots] =
    executableRoots.value;
  if (firstExecutableRoot === undefined)
    return err(
      new ConfigurationError(
        "REA_ELECTRON_AUTOMATE_EXECUTABLE_ROOTS_JSON must encode at least one absolute root when Electron automation is enabled",
      ),
    );
  const [firstApplicationRoot, ...remainingApplicationRoots] =
    applicationRoots.value;
  if (firstApplicationRoot === undefined)
    return err(
      new ConfigurationError(
        "REA_ELECTRON_AUTOMATE_APPLICATION_ROOTS_JSON must encode at least one absolute root when Electron automation is enabled",
      ),
    );
  return ok({
    status: "enabled",
    executableRoots: [firstExecutableRoot, ...remainingExecutableRoots],
    applicationRoots: [firstApplicationRoot, ...remainingApplicationRoots],
  });
};

/** Add the separately permissioned, no-network Electron automation ceiling. */
export const appendElectronAutomationCeiling = (
  ceilings: PermissionCeiling[],
  policy: ElectronAutomationPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("electron_automate", policy.applicationRoots, {
      executables: policy.executableRoots,
      network: "external",
    }),
  );
};
