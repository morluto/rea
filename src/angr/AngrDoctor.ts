import type { DoctorProviderInspection } from "../application/Doctor.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import type { Result } from "../domain/result.js";
import {
  ANGR_MCP_CONFIG_SETTING,
  ANGR_PYTHON_SETTING,
  readAngrConfiguration,
  type AngrConfiguration,
  type AngrConfigurationSources,
} from "./AngrConfiguration.js";

/** Check the registration without launching angr, retaining only the configured references. */
export const inspectAngrRegistration = async (
  sources: AngrConfigurationSources,
  resourceScope: RetainedResourceScope,
  signal?: AbortSignal,
  registration?: Promise<Result<AngrConfiguration, ConfigurationError>>,
): Promise<DoctorProviderInspection> => {
  const configured =
    sources.mcpConfigPath !== undefined || sources.pythonPath !== undefined;
  const parsed = configured
    ? await (registration ??
        readAngrConfiguration(sources, { resourceScope, signal }))
    : undefined;
  const valid = parsed?.ok === true;
  return {
    id: "angr",
    configured,
    available: valid,
    providerVersion: null,
    registrationEnvironment: valid
      ? sources.mcpConfigPath !== undefined
        ? { [ANGR_MCP_CONFIG_SETTING]: sources.mcpConfigPath }
        : sources.pythonPath !== undefined
          ? { [ANGR_PYTHON_SETTING]: sources.pythonPath }
          : {}
      : {},
    checks: [
      {
        name: "registration",
        ok: valid,
        code: valid
          ? null
          : !configured
            ? "not_configured"
            : "invalid_configuration",
        detail: valid
          ? "angr MCP registration is valid. The angr installation, its MCP extra, and target loading are checked when analysis starts; no angr process was launched."
          : parsed !== undefined && !parsed.ok
            ? parsed.error.message
            : "angr is not configured.",
        remediation: valid
          ? null
          : `Set ${ANGR_PYTHON_SETTING} to a Python interpreter with angr and its MCP extra installed, or ${ANGR_MCP_CONFIG_SETTING} to an angr MCP registration JSON; see docs/angr-provider.md.`,
        classification: configured ? "config_drift" : "missing_analysis_engine",
      },
    ],
  };
};
