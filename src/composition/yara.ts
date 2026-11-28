import { posix } from "node:path";

import { YaraMatchesService } from "../application/yara/YaraMatchesService.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { err, ok } from "../domain/result.js";
import { INSPECT_YARA_MATCHES_OPERATION } from "../domain/yara/yaraMatches.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import {
  YARA_COMMAND_REMEDIATION,
  YARA_COMMAND_SETTING,
  YARA_PROVIDER_IDENTITY,
} from "../yara/YaraProviderIdentity.js";
import {
  YaraMatchesProvider,
  type YaraCommandSelection,
} from "../yara/YaraMatchesProvider.js";
import { resolveWindowsProviderExecutable } from "./resolveWindowsProviderExecutable.js";

/**
 * Bind the configured yara executable. Relative paths are resolved against the
 * caller's working directory before the provider switches the child to the
 * filesystem root; Windows bare names are resolved on PATH.
 */
const selectYaraCommand =
  (
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform,
  ): YaraCommandSelection =>
  () => {
    const command = environment[YARA_COMMAND_SETTING] ?? "yara";
    if (command.trim() === "")
      return err(
        new AnalysisCapabilityUnavailableError(
          YARA_PROVIDER_IDENTITY.id,
          INSPECT_YARA_MATCHES_OPERATION,
          `${YARA_COMMAND_SETTING} is set but empty.`,
          { remediationAction: YARA_COMMAND_REMEDIATION },
        ),
      );
    if (platform !== "win32")
      return ok(
        command.includes("/") && !posix.isAbsolute(command)
          ? absoluteCallerPath(command, { platform })
          : command,
      );
    const resolved = resolveWindowsProviderExecutable(command, environment);
    if (resolved.ok) return resolved;
    return err(
      new AnalysisCapabilityUnavailableError(
        YARA_PROVIDER_IDENTITY.id,
        INSPECT_YARA_MATCHES_OPERATION,
        resolved.error.kind === "not_found"
          ? `The yara command ${command} was not found on PATH.`
          : `PATHEXT contains an invalid extension (${resolved.error.extension}).`,
        { remediationAction: YARA_COMMAND_REMEDIATION },
      ),
    );
  };

/**
 * Compose caller-supplied YARA scanning. Construction performs no lookup,
 * acquisition or target I/O; the command is selected when a scan starts.
 */
export const createYaraMatchesService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  settings?: AnalysisSettingsReader,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): YaraMatchesService => {
  const snapshot = { ...environment };
  return new YaraMatchesService(
    new YaraMatchesProvider({
      environment: snapshot,
      platform,
      selectCommand: selectYaraCommand(snapshot, platform),
    }),
    snapshot,
    settings,
  );
};
