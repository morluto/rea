import { ConfigurationError } from "../domain/errors.js";
import type { PermissionCeiling } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  browserEndpointSchema,
  browserOriginSchema,
} from "../domain/browserObservation.js";
import type { Environment } from "./environment.js";
import {
  parseAbsoluteRoots,
  parseBrowserArray,
  parseStringArray,
} from "./parsers.js";
import { browserNetworkScope, permissionScope } from "./permissions.js";

type BrowserScenarioTargetPolicy =
  | {
      readonly access: "launch";
      readonly executableRoots: readonly [string, ...string[]];
    }
  | {
      readonly access: "attach";
      readonly cdpEndpoints: readonly [string, ...string[]];
    }
  | {
      readonly access: "launch-or-attach";
      readonly executableRoots: readonly [string, ...string[]];
      readonly cdpEndpoints: readonly [string, ...string[]];
    };

/** Parsed availability and authority scope for controlled browser scenarios. */
export type BrowserScenarioPolicy =
  | { readonly status: "disabled" }
  | {
      readonly status: "enabled";
      readonly target: BrowserScenarioTargetPolicy;
      readonly allowedOrigins: readonly [string, ...string[]];
      readonly allowedEnvironment: readonly string[];
    };

/** Parse controlled browser scenarios into a closed disabled or enabled policy. */
export const parseBrowserScenarioPolicy = (
  env: Environment,
): Result<BrowserScenarioPolicy, ConfigurationError> => {
  const executableRoots = parseAbsoluteRoots(
    env.REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON,
    "REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON",
  );
  if (!executableRoots.ok) return executableRoots;
  const cdpEndpoints = parseBrowserArray(
    env.REA_BROWSER_SCENARIO_CDP_ENDPOINTS_JSON,
    "REA_BROWSER_SCENARIO_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!cdpEndpoints.ok) return cdpEndpoints;
  const allowedOrigins = parseBrowserArray(
    env.REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON,
    "REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON",
    browserOriginSchema,
    32,
  );
  if (!allowedOrigins.ok) return allowedOrigins;
  const allowedEnvironment = parseStringArray(
    env.REA_BROWSER_SCENARIO_ALLOWED_ENV_JSON,
    "REA_BROWSER_SCENARIO_ALLOWED_ENV_JSON",
  );
  if (!allowedEnvironment.ok) return allowedEnvironment;
  if (env.REA_BROWSER_SCENARIO_ENABLED === "false")
    return ok({ status: "disabled" });
  const [firstOrigin, ...remainingOrigins] = allowedOrigins.value;
  if (firstOrigin === undefined)
    return err(
      new ConfigurationError(
        "REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON must encode at least one exact origin when browser scenarios are enabled",
      ),
    );
  const target = parseTargetPolicy(executableRoots.value, cdpEndpoints.value);
  if (!target.ok) return target;
  return ok({
    status: "enabled",
    target: target.value,
    allowedOrigins: [firstOrigin, ...remainingOrigins],
    allowedEnvironment: allowedEnvironment.value,
  });
};

/** Add the separately permissioned controlled-browser ceiling. */
export const appendBrowserScenarioCeiling = (
  ceilings: PermissionCeiling[],
  policy: BrowserScenarioPolicy,
): void => {
  if (policy.status === "disabled") return;
  const { executableRoots, cdpEndpoints } = targetScopes(policy.target);
  ceilings.push(
    permissionScope("browser_automate", [], {
      executables: executableRoots,
      environment_names: policy.allowedEnvironment,
      origins: [...cdpEndpoints, ...policy.allowedOrigins],
      network: browserNetworkScope(policy.allowedOrigins),
    }),
  );
};

const parseTargetPolicy = (
  executableRoots: readonly string[],
  cdpEndpoints: readonly string[],
): Result<BrowserScenarioTargetPolicy, ConfigurationError> => {
  const [firstExecutableRoot, ...remainingExecutableRoots] = executableRoots;
  const [firstCdpEndpoint, ...remainingCdpEndpoints] = cdpEndpoints;
  if (firstExecutableRoot !== undefined && firstCdpEndpoint !== undefined)
    return ok({
      access: "launch-or-attach",
      executableRoots: [firstExecutableRoot, ...remainingExecutableRoots],
      cdpEndpoints: [firstCdpEndpoint, ...remainingCdpEndpoints],
    });
  if (firstExecutableRoot !== undefined)
    return ok({
      access: "launch",
      executableRoots: [firstExecutableRoot, ...remainingExecutableRoots],
    });
  if (firstCdpEndpoint !== undefined)
    return ok({
      access: "attach",
      cdpEndpoints: [firstCdpEndpoint, ...remainingCdpEndpoints],
    });
  return err(
    new ConfigurationError(
      "Browser scenarios require at least one executable root or loopback CDP endpoint when enabled",
    ),
  );
};

const targetScopes = (
  target: BrowserScenarioTargetPolicy,
): {
  readonly executableRoots: readonly string[];
  readonly cdpEndpoints: readonly string[];
} => {
  switch (target.access) {
    case "launch":
      return { executableRoots: target.executableRoots, cdpEndpoints: [] };
    case "attach":
      return { executableRoots: [], cdpEndpoints: target.cdpEndpoints };
    case "launch-or-attach":
      return target;
  }
};
