import { vi } from "vitest";

import { PRODUCT_IDENTITY } from "../../src/identity.js";

/** The default npx registration command setup writes on POSIX hosts. */
export const NPX_REGISTRATION_COMMAND = [
  "npx",
  "-y",
  PRODUCT_IDENTITY.registrationPackageSpecifier,
  "mcp",
] as const;

/** Environment variables that redirect where supported clients keep config. */
export const CLIENT_LOCATION_ENVIRONMENT = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "GROK_HOME",
  "OMP_PROFILE",
  "OPENCODE_CONFIG",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "SAND_DATA_ROOT",
  "XDG_CONFIG_HOME",
] as const;

/** Clear the developer's client locations so tests resolve only their temporary homes. */
export const clearClientLocationEnvironment = (): void => {
  for (const name of CLIENT_LOCATION_ENVIRONMENT) vi.stubEnv(name, undefined);
};
