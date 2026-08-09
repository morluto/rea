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
  parseElectronFileRoots,
} from "./parsers.js";
import { browserNetworkScope, permissionScope } from "./permissions.js";

type DisabledObservationPolicy = { readonly status: "disabled" };

/** Parsed authority scope for passive browser observation. */
export type BrowserObservationPolicy =
  | DisabledObservationPolicy
  | {
      readonly status: "enabled";
      readonly cdpEndpoints: readonly [string, ...string[]];
      readonly allowedOrigins: readonly [string, ...string[]];
    };

/** Parsed authority scope for passive Electron observation. */
export type ElectronObservationPolicy =
  | DisabledObservationPolicy
  | {
      readonly status: "enabled";
      readonly cdpEndpoints: readonly [string, ...string[]];
      readonly fileRoots: readonly [string, ...string[]];
    };

/** Parsed location authority for passive V8 Inspector observation. */
export type V8InspectorLocationPolicy =
  | {
      readonly scope: "files";
      readonly fileRoots: readonly [string, ...string[]];
    }
  | {
      readonly scope: "origins";
      readonly allowedOrigins: readonly [string, ...string[]];
    }
  | {
      readonly scope: "files-and-origins";
      readonly fileRoots: readonly [string, ...string[]];
      readonly allowedOrigins: readonly [string, ...string[]];
    };

/** Parsed authority scope for passive V8 Inspector observation. */
export type V8InspectorObservationPolicy =
  | DisabledObservationPolicy
  | {
      readonly status: "enabled";
      readonly endpoints: readonly [string, ...string[]];
      readonly locations: V8InspectorLocationPolicy;
    };

/** Complete parsed passive-observation policy family. */
export interface PassiveObservationPolicies {
  readonly browser: BrowserObservationPolicy;
  readonly electron: ElectronObservationPolicy;
  readonly v8Inspector: V8InspectorObservationPolicy;
}

/** Parse every passive observation capability into closed policy variants. */
export const parsePassiveObservationPolicies = (
  env: Environment,
): Result<PassiveObservationPolicies, ConfigurationError> => {
  const browser = parseBrowserObservationPolicy(env);
  if (!browser.ok) return browser;
  const electron = parseElectronObservationPolicy(env);
  if (!electron.ok) return electron;
  const v8Inspector = parseV8InspectorObservationPolicy(env);
  if (!v8Inspector.ok) return v8Inspector;
  return ok({
    browser: browser.value,
    electron: electron.value,
    v8Inspector: v8Inspector.value,
  });
};

/** Add permission ceilings for each enabled passive observation policy. */
export const appendPassiveObservationCeilings = (
  ceilings: PermissionCeiling[],
  policies: PassiveObservationPolicies,
): void => {
  appendBrowserCeiling(ceilings, policies.browser);
  appendElectronCeiling(ceilings, policies.electron);
  appendV8InspectorCeiling(ceilings, policies.v8Inspector);
};

/** Project the legal file and origin scopes from an enabled V8 policy. */
export const v8InspectorLocationScopes = (
  locations: V8InspectorLocationPolicy,
): {
  readonly fileRoots: readonly string[];
  readonly allowedOrigins: readonly string[];
} => {
  switch (locations.scope) {
    case "files":
      return { fileRoots: locations.fileRoots, allowedOrigins: [] };
    case "origins":
      return { fileRoots: [], allowedOrigins: locations.allowedOrigins };
    case "files-and-origins":
      return locations;
  }
};

const parseBrowserObservationPolicy = (
  env: Environment,
): Result<BrowserObservationPolicy, ConfigurationError> => {
  const endpoints = parseBrowserArray(
    env.REA_BROWSER_CDP_ENDPOINTS_JSON,
    "REA_BROWSER_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!endpoints.ok) return endpoints;
  const origins = parseBrowserArray(
    env.REA_BROWSER_ALLOWED_ORIGINS_JSON,
    "REA_BROWSER_ALLOWED_ORIGINS_JSON",
    browserOriginSchema,
    32,
  );
  if (!origins.ok) return origins;
  if (env.REA_BROWSER_OBSERVE_ENABLED !== "true")
    return ok({ status: "disabled" });
  const parsedEndpoints = requireFirst(
    endpoints.value,
    "REA_BROWSER_CDP_ENDPOINTS_JSON must encode at least one loopback endpoint when browser observation is enabled",
  );
  if (!parsedEndpoints.ok) return parsedEndpoints;
  const parsedOrigins = requireFirst(
    origins.value,
    "REA_BROWSER_ALLOWED_ORIGINS_JSON must encode at least one exact origin when browser observation is enabled",
  );
  if (!parsedOrigins.ok) return parsedOrigins;
  return ok({
    status: "enabled",
    cdpEndpoints: parsedEndpoints.value,
    allowedOrigins: parsedOrigins.value,
  });
};

const parseElectronObservationPolicy = (
  env: Environment,
): Result<ElectronObservationPolicy, ConfigurationError> => {
  const endpoints = parseBrowserArray(
    env.REA_ELECTRON_CDP_ENDPOINTS_JSON,
    "REA_ELECTRON_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!endpoints.ok) return endpoints;
  const roots = parseElectronFileRoots(env.REA_ELECTRON_FILE_ROOTS_JSON);
  if (!roots.ok) return roots;
  if (env.REA_ELECTRON_OBSERVE_ENABLED !== "true")
    return ok({ status: "disabled" });
  const parsedEndpoints = requireFirst(
    endpoints.value,
    "REA_ELECTRON_CDP_ENDPOINTS_JSON must encode at least one loopback endpoint when Electron observation is enabled",
  );
  if (!parsedEndpoints.ok) return parsedEndpoints;
  const parsedRoots = requireFirst(
    roots.value,
    "REA_ELECTRON_FILE_ROOTS_JSON must encode at least one absolute root when Electron observation is enabled",
  );
  if (!parsedRoots.ok) return parsedRoots;
  return ok({
    status: "enabled",
    cdpEndpoints: parsedEndpoints.value,
    fileRoots: parsedRoots.value,
  });
};

const parseV8InspectorObservationPolicy = (
  env: Environment,
): Result<V8InspectorObservationPolicy, ConfigurationError> => {
  const endpoints = parseBrowserArray(
    env.REA_V8_INSPECTOR_ENDPOINTS_JSON,
    "REA_V8_INSPECTOR_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!endpoints.ok) return endpoints;
  const roots = parseAbsoluteRoots(
    env.REA_V8_INSPECTOR_FILE_ROOTS_JSON,
    "REA_V8_INSPECTOR_FILE_ROOTS_JSON",
  );
  if (!roots.ok) return roots;
  const origins = parseBrowserArray(
    env.REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON,
    "REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON",
    browserOriginSchema,
    32,
  );
  if (!origins.ok) return origins;
  if (env.REA_V8_INSPECTOR_OBSERVE_ENABLED !== "true")
    return ok({ status: "disabled" });
  const parsedEndpoints = requireFirst(
    endpoints.value,
    "REA_V8_INSPECTOR_ENDPOINTS_JSON must encode at least one loopback endpoint when V8 Inspector observation is enabled",
  );
  if (!parsedEndpoints.ok) return parsedEndpoints;
  const locations = parseV8Locations(roots.value, origins.value);
  if (!locations.ok) return locations;
  return ok({
    status: "enabled",
    endpoints: parsedEndpoints.value,
    locations: locations.value,
  });
};

const parseV8Locations = (
  roots: readonly string[],
  origins: readonly string[],
): Result<V8InspectorLocationPolicy, ConfigurationError> => {
  const [firstRoot, ...remainingRoots] = roots;
  const [firstOrigin, ...remainingOrigins] = origins;
  if (firstRoot !== undefined && firstOrigin !== undefined)
    return ok({
      scope: "files-and-origins",
      fileRoots: [firstRoot, ...remainingRoots],
      allowedOrigins: [firstOrigin, ...remainingOrigins],
    });
  if (firstRoot !== undefined)
    return ok({
      scope: "files",
      fileRoots: [firstRoot, ...remainingRoots],
    });
  if (firstOrigin !== undefined)
    return ok({
      scope: "origins",
      allowedOrigins: [firstOrigin, ...remainingOrigins],
    });
  return err(
    new ConfigurationError(
      "V8 Inspector observation requires at least one file root or exact origin when enabled",
    ),
  );
};

const requireFirst = (
  values: readonly string[],
  message: string,
): Result<readonly [string, ...string[]], ConfigurationError> => {
  const [first, ...remaining] = values;
  return first === undefined
    ? err(new ConfigurationError(message))
    : ok([first, ...remaining]);
};

const appendBrowserCeiling = (
  ceilings: PermissionCeiling[],
  policy: BrowserObservationPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("browser_observe", [], {
      origins: [...policy.cdpEndpoints, ...policy.allowedOrigins],
      network: browserNetworkScope(policy.allowedOrigins),
    }),
  );
};

const appendElectronCeiling = (
  ceilings: PermissionCeiling[],
  policy: ElectronObservationPolicy,
): void => {
  if (policy.status === "disabled") return;
  ceilings.push(
    permissionScope("electron_observe", policy.fileRoots, {
      origins: policy.cdpEndpoints,
      network: "loopback",
    }),
  );
};

const appendV8InspectorCeiling = (
  ceilings: PermissionCeiling[],
  policy: V8InspectorObservationPolicy,
): void => {
  if (policy.status === "disabled") return;
  const scopes = v8InspectorLocationScopes(policy.locations);
  ceilings.push(
    permissionScope("v8_inspector_observe", scopes.fileRoots, {
      origins: [...policy.endpoints, ...scopes.allowedOrigins],
      network: "loopback",
    }),
  );
};
