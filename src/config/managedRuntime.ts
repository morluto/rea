import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import { ConfigurationError } from "../domain/errors.js";
import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Environment } from "./environment.js";
import { permissionScope } from "./permissions.js";

/** Parse managed runtime correlation into a closed disabled or enabled policy. */
export const parseManagedRuntimePolicy = (
  env: Environment,
  roots: readonly string[],
): Result<ManagedRuntimePolicy, ConfigurationError> => {
  if (env.REA_MANAGED_RUNTIME_ENABLED !== "true")
    return ok({ status: "disabled" });
  const [firstRoot, ...remainingRoots] = roots;
  if (firstRoot === undefined)
    return err(
      new ConfigurationError(
        "REA_MANAGED_RUNTIME_ROOTS_JSON must encode at least one absolute root when managed runtime correlation is enabled",
      ),
    );
  return ok({
    status: "enabled",
    roots: [firstRoot, ...remainingRoots],
    executablePath: env.REA_MANAGED_RUNTIME_EXECUTABLE_PATH,
  });
};

/** Add the separately permissioned, no-network managed runtime ceiling. */
export const appendManagedRuntimeCeiling = (
  ceilings: PermissionCeiling[],
  policy: ManagedRuntimePolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("managed_runtime", policy.roots, {
      executables: [policy.executablePath],
      network: "none",
    }),
  );
};
