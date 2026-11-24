import {
  homeDirectoryFromEnvironment,
  selectedHomeDirectorySettings,
} from "../config/homeDirectory.js";
import { USER_CONFIG_FILE_NAME } from "../config/userConfig.js";
import { mergeEnvironmentOverrides } from "../process/snapshotEnvironment.js";
import {
  appendCallerPath,
  isQualifiedCallerPath,
} from "../filesystem/callerPath.js";

const defaultConfigHome = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string =>
  appendCallerPath(
    homeDirectoryFromEnvironment(environment, platform),
    ".config",
    platform,
  );

const selectedConfigHome = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string | undefined => {
  const xdg = environment.XDG_CONFIG_HOME;
  return xdg !== undefined && isQualifiedCallerPath(xdg, platform)
    ? xdg
    : undefined;
};

const configFileAt = (root: string, platform: NodeJS.Platform): string =>
  appendCallerPath(
    appendCallerPath(root, "rea", platform),
    USER_CONFIG_FILE_NAME,
    platform,
  );

/** Retain the caller's native traversal to the selected config file. */
export const userConfigFilePath = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string =>
  configFileAt(
    selectedConfigHome(environment, platform) ??
      defaultConfigHome(environment, platform),
    platform,
  );

/** Settings needed to select the saved file with the current literal values. */
export const userConfigLocationSettings = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): ReadonlySet<string> => {
  return new Set([
    "XDG_CONFIG_HOME",
    ...(selectedConfigHome(environment, platform) === undefined
      ? selectedHomeDirectorySettings(platform, environment)
      : []),
  ]);
};

/** A session-independent locator for clients that rely on saved defaults. */
export const userConfigRegistrationFallback = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> => {
  const selected = selectedConfigHome(environment, platform);
  return selected === undefined ||
    configFileAt(selected, platform) ===
      configFileAt(defaultConfigHome(environment, platform), platform)
    ? {}
    : { XDG_CONFIG_HOME: selected };
};

/** The locator is a fallback. All other proposed settings are overrides. */
export const registrationEnvironmentProposal = (
  proposed: Readonly<Record<string, string>>,
): {
  readonly configHomeFallback?: string;
  readonly overrides: Readonly<Record<string, string>>;
} => {
  if (!Object.hasOwn(proposed, "XDG_CONFIG_HOME"))
    return { overrides: proposed };
  const { XDG_CONFIG_HOME: configHomeFallback, ...overrides } = proposed;
  return configHomeFallback === undefined
    ? { overrides }
    : { configHomeFallback, overrides };
};

export const mergeRegistrationEnvironment = <Value>(
  existing: Readonly<Record<string, Value>>,
  proposed: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): {
  readonly values: Readonly<Record<string, Value | string>>;
  readonly configHomeFallbackApplied?: true;
} => {
  const { configHomeFallback, overrides } =
    registrationEnvironmentProposal(proposed);
  const values = mergeEnvironmentOverrides<Value | string>(
    existing,
    overrides,
    platform,
  );
  if (
    configHomeFallback === undefined ||
    Object.keys(values).some(
      (name) =>
        (platform === "win32" ? name.toUpperCase() : name) ===
        "XDG_CONFIG_HOME",
    )
  )
    return { values };
  return {
    values: { ...values, XDG_CONFIG_HOME: configHomeFallback },
    configHomeFallbackApplied: true,
  };
};
