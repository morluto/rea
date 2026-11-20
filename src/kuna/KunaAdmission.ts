import { accessSync, constants, statSync } from "node:fs";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readKunaConfiguration,
  type KunaConfiguration,
  type KunaConfigurationFailure,
} from "./KunaConfiguration.js";
import { KUNA_COMMAND_REMEDIATION } from "./KunaRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Why Kuna is not admitted: its settings, or a command REA cannot run. */
export interface KunaAdmissionRefusal {
  readonly code: KunaConfigurationFailure["code"] | "executable_missing";
  readonly reason: string;
  readonly remediation: string;
  /** The setting whose value was refused, when one was. */
  readonly setting: string | null;
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
}

/**
 * Kuna's readiness: valid settings and a configured command that is an
 * executable regular file. Runtime availability and `rea doctor` both project
 * this one decision. It launches nothing and touches no cache; doctor's
 * version probe and cache inspection are health checks reported beside it.
 */
export const admitKunaCommand = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Result<KunaConfiguration, KunaAdmissionRefusal> => {
  const configuration = readKunaConfiguration(environment, platform);
  if (!configuration.ok) {
    const { code, reason, remediation, setting } = configuration.error;
    return err({
      code,
      reason,
      remediation,
      setting,
      diagnostics: {
        configured: code !== "not_configured",
        ...(setting === null ? {} : { setting }),
      },
    });
  }
  const { command } = configuration.value;
  const refused = (reason: string): Result<never, KunaAdmissionRefusal> =>
    err({
      code: "executable_missing",
      reason: `${reason} ${KUNA_COMMAND_REMEDIATION}`,
      remediation: KUNA_COMMAND_REMEDIATION,
      setting: "REA_KUNA_COMMAND",
      diagnostics: { configured: true, command },
    });
  try {
    accessSync(command, constants.X_OK);
    if (!statSync(command).isFile())
      return refused(`REA_KUNA_COMMAND is not a regular file: ${command}.`);
  } catch (cause: unknown) {
    return refused(
      `Cannot execute REA_KUNA_COMMAND ${command}: ${errorMessage(cause)}.`,
    );
  }
  return ok(configuration.value);
};
