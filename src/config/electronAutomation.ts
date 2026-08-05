import { isAbsolute } from "node:path";

import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import { ConfigurationError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { permissionScope } from "./permissions.js";
import { parseStringArray } from "./parsers.js";
import type { Environment } from "./environment.js";

export interface ElectronAutomationArrays {
  readonly electronAutomationExecutableRoots: readonly string[];
  readonly electronAutomationApplicationRoots: readonly string[];
}

/** Parse the exact filesystem roots admitted for active Electron automation. */
export const parseElectronAutomationArrays = (
  env: Environment,
): Result<ElectronAutomationArrays, ConfigurationError> => {
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
  return ok({
    electronAutomationExecutableRoots: executableRoots.value,
    electronAutomationApplicationRoots: applicationRoots.value,
  });
};

/** Add the separately permissioned, no-network Electron automation ceiling. */
export const appendElectronAutomationCeiling = (
  ceilings: PermissionCeiling[],
  env: Environment,
  arrays: ElectronAutomationArrays,
): void => {
  if (env.REA_ELECTRON_AUTOMATE_ENABLED !== "true") return;
  ceilings.push(
    permissionScope(
      "electron_automate",
      arrays.electronAutomationApplicationRoots,
      {
        executables: arrays.electronAutomationExecutableRoots,
        network: "external",
      },
    ),
  );
};

const parseAbsoluteRoots = (
  value: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  const parsed = parseStringArray(value, name);
  if (!parsed.ok) return parsed;
  return parsed.value.some((root) => !isAbsolute(root))
    ? err(new ConfigurationError(`${name} must encode absolute roots`))
    : parsed;
};
