import type { DoctorProviderInspection } from "../ports/DoctorProviderInspection.js";
import {
  leandecAvailability,
  resolveLeandecSettings,
} from "./LeandecSettings.js";

export const LEANDEC_DOCTOR_SETTINGS = [
  "LEANDEC_MCP_SERVER",
  "LEANDEC_PYTHON",
  "PATH",
  "LEANDEC_HOME",
] as const;

/** Side-effect-free configuration inspection; runtime analysis is a separate check. */
export const inspectLeandecProvider = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): DoctorProviderInspection => {
  const resolution = resolveLeandecSettings(environment);
  const availability = leandecAvailability(resolution, platform);
  return {
    id: "leandec",
    configured: Boolean(environment.LEANDEC_MCP_SERVER?.trim()),
    available: availability.status === "available",
    providerVersion: resolution.ok ? resolution.settings.serverVersion : null,
    registrationEnvironment: {},
    checks:
      availability.status === "available"
        ? [
            {
              name: "installation",
              ok: true,
              code: null,
              classification: "healthy",
              detail:
                "Leandec server file and Python interpreter are accessible; MCP/Ghidra runtime not probed.",
              remediation: null,
              details: availability.diagnostics,
            },
          ]
        : [
            {
              name: "installation",
              ok: false,
              code: availability.code,
              classification:
                availability.code === "unsupported_host"
                  ? "unsupported_host"
                  : "missing_dependency",
              detail: availability.reason,
              remediation: availability.remediation,
              details: availability.diagnostics,
            },
          ],
  };
};
