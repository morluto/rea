import type { DoctorProviderInspection } from "../application/Doctor.js";
import {
  readBinaryNinjaConfiguration,
  type BinaryNinjaConfiguration,
} from "./BinaryNinjaConfiguration.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import type { Result } from "../domain/result.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";

/** Check the registration without connecting, and retain only the configuration file reference. */
export const inspectBinaryNinjaRegistration = async (
  path: string | undefined,
  resourceScope: RetainedResourceScope,
  signal?: AbortSignal,
  registration?: Promise<Result<BinaryNinjaConfiguration, ConfigurationError>>,
): Promise<DoctorProviderInspection> => {
  const parsed =
    path === undefined
      ? undefined
      : await (registration ??
          readBinaryNinjaConfiguration(path, {
            resourceScope,
            ...(signal === undefined ? {} : { signal }),
          }));
  const valid = parsed?.ok === true;
  return {
    id: "binary-ninja",
    configured: path !== undefined,
    available: valid,
    providerVersion: null,
    registrationEnvironment:
      valid && path !== undefined ? { REA_BINARY_NINJA_MCP_CONFIG: path } : {},
    checks: [
      {
        name: "registration",
        ok: valid,
        code: valid
          ? null
          : path === undefined
            ? "not_configured"
            : "invalid_configuration",
        detail: valid
          ? "Binary Ninja MCP registration is valid. Server availability, the open file, and its identity are checked when analysis starts; no connection was made."
          : parsed !== undefined && !parsed.ok
            ? parsed.error.message
            : "Binary Ninja MCP registration is not configured.",
        remediation: valid
          ? null
          : "Set REA_BINARY_NINJA_MCP_CONFIG to your Binary Ninja GUI MCP registration JSON; see docs/binary-ninja.md.",
        classification:
          path === undefined ? "missing_analysis_engine" : "config_drift",
      },
    ],
  };
};
