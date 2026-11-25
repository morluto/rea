import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../ports/DoctorProviderInspection.js";
import {
  readIdaConfiguration,
  type IdaConfiguration,
} from "./IdaConfiguration.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Result } from "../domain/result.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import {
  admitIdaConfiguration,
  IDA_WORKSPACE_ROOT_REMEDIATION,
  type IdaAdmission,
} from "./IdaAdmission.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";

/** Client settings consulted by this readiness probe. */
export const IDA_DOCTOR_SETTINGS = ["REA_IDA_MCP_CONFIG"] as const;

/** Check the registration without launching IDA, and retain only the configuration file reference. */
export const inspectIdaRegistration = async (
  path: string | undefined,
  resourceScope: RetainedResourceScope,
  signal?: AbortSignal,
  registration?: Promise<Result<IdaConfiguration, ConfigurationError>>,
): Promise<DoctorProviderInspection> => {
  const parsed =
    path === undefined
      ? undefined
      : await (registration ??
          readIdaConfiguration(path, {
            resourceScope,
            ...(signal === undefined ? {} : { signal }),
          }));
  const valid = parsed?.ok === true;
  const admission =
    parsed?.ok === true ? await admitIdaConfiguration(parsed.value) : undefined;
  const workspaceChecks =
    admission === undefined ? [] : privateWorkspaceChecks(admission);
  return {
    id: "ida",
    configured: path !== undefined,
    available: admission?.admitted === true,
    providerVersion: null,
    registrationEnvironment:
      valid && path !== undefined ? { REA_IDA_MCP_CONFIG: path } : {},
    checks: [
      valid
        ? {
            name: "registration",
            ok: true,
            code: null,
            detail:
              "IDA MCP registration is valid. Upstream availability, compatibility, and target binding are checked when analysis starts; no IDA process was launched.",
            remediation: null,
            classification: "healthy",
          }
        : {
            name: "registration",
            ok: false,
            code:
              path === undefined ? "not_configured" : "invalid_configuration",
            detail:
              parsed !== undefined && !parsed.ok
                ? parsed.error.message
                : "IDA MCP registration is not configured.",
            // An invalid registration carries the repair runtime readiness reports.
            remediation:
              parsed !== undefined && !parsed.ok
                ? projectAnalysisError(parsed.error).remediation.action
                : "Set REA_IDA_MCP_CONFIG to your upstream IDA MCP registration JSON; see docs/providers/ida-provider.md.",
            classification:
              path === undefined ? "missing_analysis_engine" : "config_drift",
          },
      ...workspaceChecks,
    ],
  };
};

/** Project IDA's admission into the doctor's private workspace check. */
const privateWorkspaceChecks = (
  admission: IdaAdmission,
): readonly DoctorProviderCheck[] => {
  if (admission.admitted)
    return admission.workspace === undefined
      ? []
      : [
          {
            name: "private_workspace",
            ok: true,
            code: null,
            detail: `Private workspace authority is available (${admission.workspace.proof}) under ${admission.workspace.root ?? "the system temporary directory"}.`,
            remediation: null,
            classification: "healthy",
          },
        ];
  const { refusal } = admission;
  switch (refusal.kind) {
    case "workspace_unusable":
      return [
        {
          name: "private_workspace",
          ok: false,
          code: "invalid_configuration",
          detail: refusal.reason,
          remediation: IDA_WORKSPACE_ROOT_REMEDIATION,
          classification: "config_drift",
        },
      ];
    case "private_workspace_unavailable": {
      const { privacy } = refusal;
      return [
        {
          name: "private_workspace",
          ok: false,
          code: privacy.code,
          detail: privacy.reason,
          remediation: privacy.remediation,
          classification:
            privacy.code === "runtime_missing"
              ? "missing_dependency"
              : privacy.code === "runtime_unavailable"
                ? "runtime_failure"
                : "unsupported_host",
        },
      ];
    }
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
};
