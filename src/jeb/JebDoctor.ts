import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import { parseJebMcpTimeoutMs } from "../config/environment.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { parseJebMcpEndpoint } from "./JebMcpEndpoint.js";

/** Check selected JEB settings without launching the engine, retaining the validated endpoint independently of readiness. */
export const inspectJebRegistration = (
  environment: Readonly<Record<string, string | undefined>>,
): DoctorProviderInspection => {
  const value = environment.REA_JEB_MCP_URL;
  const parsed = parseJebMcpEndpoint(value);
  const valid = parsed.ok;
  const requestTimeout = parseJebMcpTimeoutMs(
    environment.REA_JEB_MCP_TIMEOUT_MS,
  );
  const timeoutChecks: readonly DoctorProviderCheck[] = requestTimeout.ok
    ? []
    : [
        {
          name: "request-timeout",
          ok: false,
          code: "invalid_configuration",
          detail: requestTimeout.error.settings
            .map(({ setting, constraint }) => `${setting}: ${constraint}`)
            .join("; "),
          remediation:
            "Fix REA_JEB_MCP_TIMEOUT_MS or unset it to use the default request budget; see docs/jeb-analysis.md.",
          classification: "config_drift",
        },
      ];
  const availabilityChecks: readonly DoctorProviderCheck[] =
    valid && requestTimeout.ok
      ? [
          {
            name: "availability",
            ok: false,
            code: "not_probed",
            detail:
              "JEB service availability is unverified: syntax-only inspection made no request. Compatibility and project binding are also unverified.",
            remediation:
              "Run rea inspect-jeb-client for a read-only service query, or use MCP binary_session to probe operation availability. This doctor check does not contact JEB.",
            classification: "unknown",
          },
        ]
      : [];
  return {
    id: "jeb",
    // The runtime has a default endpoint even without a saved override.
    configured: true,
    // Valid registration is not proof that a compatible service is running.
    available: false,
    providerVersion: null,
    registrationEnvironment:
      valid && value !== undefined && value.length > 0
        ? { REA_JEB_MCP_URL: value }
        : {},
    checks: [
      {
        name: "registration",
        ok: valid,
        code: valid ? null : "invalid_configuration",
        detail: parsed.ok
          ? `JEB MCP endpoint ${parsed.value.href} is valid. Upstream availability, compatibility, and project binding are checked when analysis starts; no JEB process was launched.`
          : `JEB MCP endpoint is invalid: ${endpointConstraint(parsed.error)}.`,
        remediation: valid
          ? null
          : "Set REA_JEB_MCP_URL to your running JEB MCP endpoint; see docs/jeb-analysis.md.",
        classification: "config_drift",
      },
      ...timeoutChecks,
      ...availabilityChecks,
    ],
  };
};

const endpointConstraint = (error: AnalysisError): string =>
  typeof error.cause === "string" && error.cause.length > 0
    ? error.cause
    : error.message;
