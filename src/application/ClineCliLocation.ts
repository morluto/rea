import { posix, win32 } from "node:path";

import { err, ok, type Result } from "../domain/result.js";
import {
  absoluteClientRoot,
  type ClientRootFailure,
} from "./ClientConfigRoots.js";

/**
 * Cline CLI's settings selection, shared by setup and explicit MCP
 * registration. Its override variables resolve against Cline's working
 * directory, so a relative one is refused like the other client roots.
 */
export const resolveClineCliSettingsPath = (context: {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Result<string, ClientRootFailure> => {
  const { environment, home, platform } = context;
  const pathApi = platform === "win32" ? win32 : posix;
  const explicit = (variable: string) => {
    const value = environment[variable]?.trim();
    return value
      ? absoluteClientRoot(value, variable, "Cline CLI", platform)
      : undefined;
  };
  const explicitPath = explicit("CLINE_MCP_SETTINGS_PATH");
  if (explicitPath) return explicitPath;
  const explicitData = explicit("CLINE_DATA_DIR");
  if (explicitData)
    return explicitData.ok
      ? ok(
          pathApi.join(
            explicitData.value,
            "settings",
            "cline_mcp_settings.json",
          ),
        )
      : explicitData;
  const explicitDirectory = explicit("CLINE_DIR");
  if (explicitDirectory)
    return explicitDirectory.ok
      ? ok(
          pathApi.join(
            explicitDirectory.value,
            "data",
            "settings",
            "cline_mcp_settings.json",
          ),
        )
      : explicitDirectory;
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
    return err({
      path: "",
      message:
        "Cannot determine Cline CLI's system home from the selected environment. Set CLINE_MCP_SETTINGS_PATH, CLINE_DATA_DIR, or CLINE_DIR to select its configuration location.",
    });
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
