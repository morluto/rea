import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../ports/DoctorProviderInspection.js";
import { parseJebMcpTimeoutMs } from "../config/environment.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { parseJebMcpEndpoint } from "../config/jebMcpEndpoint.js";

/** Settings consumed by syntax-only registration inspection. */
export const JEB_DOCTOR_SETTINGS = [
  "REA_JEB_MCP_URL",
  "REA_JEB_MCP_TIMEOUT_MS",
] as const;

/** Check selected JEB settings without launching the engine, retaining the validated endpoint independently of readiness. */
export const inspectJebRegistration = (
  environment: Readonly<Record<string, string | undefined>>,
  unresolvedSettings: ReadonlySet<string> = new Set(),
): DoctorProviderInspection => {
  const value = environment.REA_JEB_MCP_URL;
  const selected =
    (!unresolvedSettings.has("REA_JEB_MCP_URL") &&
      value !== undefined &&
      value.length > 0) ||
    environment.REA_JEB_MCP_TIMEOUT_MS !== undefined ||
    unresolvedSettings.has("REA_JEB_MCP_TIMEOUT_MS");
  const parsed = unresolvedSettings.has("REA_JEB_MCP_URL")
    ? undefined
    : parseJebMcpEndpoint(value);
  const valid = parsed?.ok === true;
  const requestTimeout = unresolvedSettings.has("REA_JEB_MCP_TIMEOUT_MS")
    ? undefined
    : parseJebMcpTimeoutMs(environment.REA_JEB_MCP_TIMEOUT_MS);
  const unknownCheck = (
    name: string,
    setting: string,
  ): DoctorProviderCheck => ({
    name,
    ok: false,
    code: "registration_environment_unknown",
    classification: "unknown",
    detail: `Selected client setting ${setting} is an unresolved expression; its value cannot be inspected.`,
    remediation: `Resolve ${setting} in the selected client registration before checking JEB readiness.`,
  });
  const timeoutChecks: readonly DoctorProviderCheck[] =
    requestTimeout === undefined
      ? [unknownCheck("request-timeout", "REA_JEB_MCP_TIMEOUT_MS")]
      : requestTimeout.ok
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
                "Fix REA_JEB_MCP_TIMEOUT_MS or unset it to use the default request budget; see docs/providers/jeb-analysis.md.",
              classification: "config_drift",
            },
          ];
  const availabilityChecks: readonly DoctorProviderCheck[] =
    valid && requestTimeout?.ok === true
      ? [
          {
            name: "availability",
            ok: false,
            code: "not_probed",
            detail:
              "JEB service availability is unverified: syntax-only inspection made no request. Compatibility and project binding are also unverified.",
            remediation:
              'Include jeb in the selected client\'s current tool-family selection and restart after any scope change. With a hot-cold catalog, first call discover_tools with names=["inspect_jeb_client"] and refresh tools/list; then use MCP inspect_jeb_client to probe its endpoint. For a terminal query, first set REA_JEB_MCP_URL and REA_JEB_MCP_TIMEOUT_MS to the diagnosed settings, then run rea inspect-jeb-client. This doctor check does not contact JEB.',
            classification: "unknown",
          },
        ]
      : [];
  return {
    id: "jeb",
    // Effective defaults are valid without making this optional provider a
    // mandatory full-audit check or suppressing first-run provider setup.
    configured: selected
      ? true
      : unresolvedSettings.has("REA_JEB_MCP_URL")
        ? null
        : false,
    // Valid registration is not proof that a compatible service is running.
    available:
      (parsed !== undefined && !parsed.ok) ||
      (requestTimeout !== undefined && !requestTimeout.ok)
        ? false
        : null,
    providerVersion: null,
    registrationEnvironment:
      valid && value !== undefined && value.length > 0
        ? { REA_JEB_MCP_URL: value }
        : {},
    checks: [
      parsed === undefined
        ? unknownCheck("registration", "REA_JEB_MCP_URL")
        : {
            name: "registration",
            ok: valid,
            code: valid ? null : "invalid_configuration",
            detail: parsed.ok
              ? `JEB MCP endpoint ${parsed.value.href} is valid. Upstream availability, compatibility, and project binding are checked when analysis starts; no JEB process was launched.`
              : `JEB MCP endpoint is invalid: ${endpointConstraint(parsed.error)}.`,
            remediation: valid
              ? null
              : "Set REA_JEB_MCP_URL to your running JEB MCP endpoint; see docs/providers/jeb-analysis.md.",
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
