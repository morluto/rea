import type { ArtifactResourceScope } from "../resources/index.js";
import { err, ok, type Result } from "../domain/result.js";
import { clientConfigurationRecordSchema } from "./ClientConfigurationDocument.js";
import {
  readConfigurationText,
  type ClientConfigurationFileError,
} from "./ClientConfigurationFiles.js";
import { errorMessage } from "../kernel/errorMessage.js";

/**
 * Inputs that decide whether Junie loads its default user MCP location. They
 * are resolved with the client's row; only the user configuration file is
 * read when a registration is inspected or written.
 */
export interface JunieLocationSettings {
  /** `$JUNIE_HOME/config.json`, which can set `mcp-default-locations`. */
  readonly userConfigPath: string;
  readonly mcpDefaultLocations?: string;
  readonly configLocation?: string;
  readonly configDefaultLocations?: string;
}

/**
 * Why Junie would not load its default user MCP file, if it would not. An
 * extra configuration location REA cannot inspect leaves that unknown, which
 * also blocks. A command-line `--mcp-default-locations=false` is invisible
 * to REA.
 */
export const readJunieLocationBlock = async (
  settings: JunieLocationSettings,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  if (settings.mcpDefaultLocations?.toLowerCase() === "false")
    return ok(
      "Junie's default MCP locations are disabled by JUNIE_MCP_DEFAULT_LOCATIONS, so Junie does not load this registration.",
    );
  if (settings.configLocation)
    return ok(
      "Cannot determine Junie's MCP location selection while JUNIE_CONFIG_LOCATION is set. Inspect the additional Junie configuration before registering.",
    );
  if (settings.configDefaultLocations?.toLowerCase() === "false")
    return ok(undefined);
  const read = await readConfigurationText(settings.userConfigPath, resources);
  if (!read.ok)
    return err({
      ...read.error,
      detail: `Cannot inspect Junie's user configuration to determine its MCP locations. ${read.error.detail}`,
    });
  if (read.value === undefined) return ok(undefined);
  // Junie reads config.json as strict JSON: comments, trailing commas or an
  // empty file leave its MCP location choice unknown rather than default.
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path: settings.userConfigPath,
      detail: `Cannot parse Junie's user configuration as JSON to determine its MCP locations: ${errorMessage(cause)}`,
    });
  }
  const record = clientConfigurationRecordSchema.safeParse(parsed);
  const value = record.success
    ? record.data["mcp-default-locations"]
    : undefined;
  if (record.success && value === undefined) return ok(undefined);
  if (typeof value !== "boolean")
    return err({
      kind: "malformed",
      path: settings.userConfigPath,
      detail:
        "Junie's user configuration does not establish whether default MCP locations are enabled: mcp-default-locations is not a boolean.",
    });
  return ok(
    value
      ? undefined
      : "Junie's user configuration disables its default MCP locations, so Junie does not load this registration.",
  );
};
