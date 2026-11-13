import { posix, win32 } from "node:path";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Cline CLI's settings selection, shared by setup and explicit MCP registration. */
export const resolveClineCliSettingsPath = (context: {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Result<string, ConfigurationError> => {
  const { environment, home, platform } = context;
  const pathApi = platform === "win32" ? win32 : posix;
  const explicitPath = environment.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicitPath) return ok(explicitPath);
  const explicitData = environment.CLINE_DATA_DIR?.trim();
  if (explicitData)
    return ok(
      pathApi.join(explicitData, "settings", "cline_mcp_settings.json"),
    );
  const explicitDirectory = environment.CLINE_DIR?.trim();
  if (explicitDirectory)
    return ok(
      pathApi.join(
        explicitDirectory,
        "data",
        "settings",
        "cline_mcp_settings.json",
      ),
    );
  const envHome = environment.HOME?.trim();
  const profile = environment.USERPROFILE?.trim();
  const drive = environment.HOMEDRIVE?.trim();
  const path = environment.HOMEPATH?.trim();
  // Cline falls back to os.homedir(), then to the literal "~". On POSIX,
  // a present HOME is returned by os.homedir() even if empty or "~".
  // Otherwise use the supplied account home only when it was not selected
  // from a rejected environment value; that value cannot prove the OS home.
  const rejectedHome = platform !== "win32" && environment.HOME !== undefined;
  const fallbackUncertain =
    (platform === "win32" &&
      (environment.USERPROFILE !== undefined ||
        Boolean(environment.HOMEDRIVE && environment.HOMEPATH) ||
        Boolean(environment.HOME))) ||
    (platform !== "win32" &&
      environment.HOME === undefined &&
      environment.USERPROFILE !== undefined);
  const nativeHome = rejectedHome
    ? "~"
    : fallbackUncertain
      ? undefined
      : home.trim() || "~";
  const clineHome =
    (envHome && envHome !== "~" ? envHome : undefined) ||
    profile ||
    (drive && path ? `${drive}${path}` : undefined) ||
    nativeHome;
  if (!clineHome)
    return err(
      new ConfigurationError(
        "Cannot determine Cline CLI's system home from the selected environment. Set CLINE_MCP_SETTINGS_PATH, CLINE_DATA_DIR, or CLINE_DIR to select its configuration location.",
      ),
    );
  return ok(
    pathApi.join(
      clineHome,
      ".cline",
      "data",
      "settings",
      "cline_mcp_settings.json",
    ),
  );
};
