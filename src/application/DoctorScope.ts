import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import type {
  DoctorCheck,
  DoctorProviderInspection,
  DoctorScope,
} from "./Doctor.js";
import { doctorHealthy } from "./DoctorDiagnostics.js";

/** Normalized readiness boundary included in every doctor response. */
export interface DoctorScopeReport {
  readonly mode: "audit-wide" | "explicit";
  readonly clients: readonly string[];
  readonly providers: readonly string[];
  readonly skill: boolean;
  readonly target: string | null;
}

interface DoctorProviderState {
  readonly hopperAvailable: boolean;
  readonly hopperConfigured: boolean;
  readonly providerInspections: readonly DoctorProviderInspection[] | undefined;
}

interface DoctorScopeInput {
  readonly checks: readonly DoctorCheck[];
  readonly registrations: readonly ClientRegistrationStatus[];
  readonly skillState: "aligned" | "stale" | "missing";
  readonly providers: DoctorProviderState;
  readonly scope: DoctorScopeReport;
}

/** Normalize a caller-selected doctor readiness boundary. */
export const normalizeDoctorScope = (
  requested: DoctorScope | undefined,
  target: string | undefined,
): DoctorScopeReport => ({
  mode: requested === undefined ? "audit-wide" : "explicit",
  clients: uniqueSorted(requested?.clients ?? []),
  providers: uniqueSorted(requested?.providers ?? []),
  skill: requested?.skill === true,
  target: target ?? null,
});

/** Partition diagnostics into required and informational scope checks. */
export const scopeDoctorChecks = (
  input: DoctorScopeInput,
): {
  readonly healthy: boolean;
  readonly scopeChecks: readonly DoctorCheck[];
  readonly informationalChecks: readonly DoctorCheck[];
} => {
  const providerChecks = input.checks.filter((candidate) =>
    isProviderCheck(candidate.name, input.providers.providerInspections),
  );
  const coreChecks = input.checks.filter(
    ({ name }) =>
      !isProviderCheck(name, input.providers.providerInspections) &&
      name !== "skill:identity" &&
      !name.startsWith("registration:"),
  );
  const clientChecks = input.scope.clients.map((client) =>
    selectedRegistrationCheck(
      client,
      input.registrations.find((candidate) => candidate.client === client),
    ),
  );
  const skillChecks = input.scope.skill
    ? [selectedSkillCheck(input.skillState, input.checks)]
    : [];
  const selectedProviderChecks =
    input.scope.providers.length === 0
      ? configuredProviderChecks(providerChecks, input.providers)
      : input.scope.providers.flatMap((providerId) =>
          selectedProviderChecksFor(
            providerId,
            providerChecks,
            input.providers,
          ),
        );
  const scopeChecks = [
    ...coreChecks,
    ...selectedProviderChecks,
    ...clientChecks,
    ...skillChecks,
  ];
  const providerHealthy =
    input.scope.providers.length === 0
      ? doctorHealthy(
          [...coreChecks, ...providerChecks, ...clientChecks, ...skillChecks],
          input.providers,
        )
      : selectedProviderChecks.every(({ ok }) => ok);
  const selectedNames = new Set(scopeChecks.map(({ name }) => name));
  return {
    healthy:
      coreChecks.every(({ ok }) => ok) &&
      clientChecks.every(({ ok }) => ok) &&
      skillChecks.every(({ ok }) => ok) &&
      providerHealthy,
    scopeChecks,
    informationalChecks: input.checks.filter(
      ({ name }) => !selectedNames.has(name),
    ),
  };
};

const isProviderCheck = (
  name: string,
  inspections: readonly DoctorProviderInspection[] | undefined,
): boolean =>
  name.startsWith("hopper") ||
  inspections?.some(({ id }) => doctorProviderCheckName(id, name)) === true;

const configuredProviderChecks = (
  checks: readonly DoctorCheck[],
  providers: DoctorProviderState,
): readonly DoctorCheck[] =>
  checks.filter(({ name }) =>
    name.startsWith("hopper")
      ? providers.hopperConfigured
      : providers.providerInspections?.some(
          ({ id, configured }) =>
            configured && doctorProviderCheckName(id, name),
        ) === true,
  );

const selectedProviderChecksFor = (
  providerId: string,
  checks: readonly DoctorCheck[],
  providers: DoctorProviderState,
): readonly DoctorCheck[] => {
  const selected = checks.filter(({ name }) =>
    providerId === "hopper"
      ? name.startsWith("hopper")
      : doctorProviderCheckName(providerId, name),
  );
  const available =
    providerId === "hopper"
      ? providers.hopperAvailable
      : providers.providerInspections?.find(({ id }) => id === providerId)
          ?.available === true;
  if (available && selected.every(({ ok }) => ok)) return selected;
  if (selected.some(({ ok }) => !ok)) return selected;
  return [
    ...selected,
    {
      name: `provider:${providerId}`,
      ok: false,
      classification: "missing_analysis_engine",
      detail: `Requested provider ${providerId} is unavailable.`,
      remediation: `Configure the ${providerId} provider, then rerun rea doctor.`,
    },
  ];
};

const selectedRegistrationCheck = (
  client: string,
  status: ClientRegistrationStatus | undefined,
): DoctorCheck =>
  status === undefined
    ? {
        name: `registration:${client}`,
        ok: false,
        classification: "config_drift",
        detail: `Requested client ${client} was not detected.`,
        remediation: `Install or select ${client}, then run rea setup --client ${client}.`,
      }
    : status.state === "aligned"
      ? {
          name: `registration:${client}`,
          ok: true,
          classification: "healthy",
          detail: status.config_path,
        }
      : registrationCheck(status);

const registrationCheck = (status: ClientRegistrationStatus): DoctorCheck => ({
  name: `registration:${status.client}`,
  ok: false,
  classification: "config_drift",
  detail: status.config_path,
  remediation:
    status.remediation ?? "Run rea setup, then restart the affected client.",
});

const selectedSkillCheck = (
  state: DoctorScopeInput["skillState"],
  checks: readonly DoctorCheck[],
): DoctorCheck =>
  checks.find(({ name }) => name === "skill:identity") ?? {
    name: "skill:identity",
    ok: state === "aligned",
    classification: state === "aligned" ? "healthy" : "config_drift",
    ...(state === "aligned"
      ? { detail: "Installed REA skill identity is aligned." }
      : { remediation: "Run rea setup to update the installed REA skill." }),
  };

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const doctorProviderCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
