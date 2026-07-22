import type { DoctorCheck, DoctorReport } from "./Doctor.js";

/** Project doctor diagnostics for concise CLI output or explicit full detail. */
export const projectDoctorReport = (
  report: DoctorReport,
  detail: "summary" | "full",
): DoctorReport | ReturnType<typeof doctorSummary> =>
  detail === "full" ? report : doctorSummary(report);

const doctorSummary = (report: DoctorReport) => ({
  healthy: report.healthy,
  environment_healthy: report.environment_healthy,
  scope: report.scope,
  ...(report.hopperPath === undefined
    ? {}
    : { hopper_path: report.hopperPath }),
  providers: (report.providerInspections ?? []).map((provider) => ({
    id: provider.id,
    configured: provider.configured,
    available: provider.available,
    provider_version: provider.providerVersion,
    failed_checks: provider.checks.filter(({ ok }) => !ok).map(checkSummary),
  })),
  failed_scope_checks: report.scope_checks
    .filter(({ ok }) => !ok)
    .map(checkSummary),
  informational_drift_count: report.informational_checks.filter(({ ok }) => !ok)
    .length,
  identity:
    report.identity === undefined
      ? null
      : {
          cli_package_version: report.identity.cli_package_version,
          expected_skill_version: report.identity.expected_skill_version,
          catalog: {
            counts: report.identity.catalog.counts,
            digests: report.identity.catalog.digests,
          },
          installations: report.identity.installations,
          skill: report.identity.skill,
          registrations: report.identity.registrations,
        },
});

const checkSummary = (
  check: Pick<DoctorCheck, "name" | "classification" | "detail"> & {
    readonly remediation?: string | null;
  },
) => ({
  name: check.name,
  classification: check.classification,
  ...(check.detail === undefined ? {} : { detail: check.detail }),
  ...(check.remediation === undefined || check.remediation === null
    ? {}
    : { remediation: check.remediation }),
});
