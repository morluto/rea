import { uniqueSorted } from "../domain/canonicalOrdering.js";
import { blocksProcessStart } from "../config/processStart.js";
import type {
  ClientRegistrationStatus,
  UnhealthyClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import { manualRegistrationRemediation } from "./SupportedClients.js";
import type {
  DoctorCheck,
  DoctorProviderInspection,
  DoctorScope,
  DoctorSkillState,
} from "./Doctor.js";

/** Normalized readiness boundary included in every doctor response. */
export interface DoctorScopeReport {
  readonly mode: "audit-wide" | "explicit";
  readonly clients: readonly string[];
  readonly skill_clients?: readonly string[];
  readonly providers: readonly string[];
  readonly skill: boolean;
  readonly target: string | null;
}

interface DoctorProviderState {
  readonly hopperAvailable: boolean;
  readonly hopperConfigured: boolean;
  /** A launcher was found, whether or not its later checks pass. */
  readonly hopperDiscovered?: boolean;
  readonly providerInspections: readonly DoctorProviderInspection[] | undefined;
}

interface DoctorScopeInput {
  readonly checks: readonly DoctorCheck[];
  readonly registrations: readonly ClientRegistrationStatus[];
  readonly skillState: DoctorSkillState;
  readonly providers: DoctorProviderState;
  readonly scope: DoctorScopeReport;
}

/**
 * The clients, providers and skill this host has set up, with their readiness
 * under the explicit-scope rules, so an audit-wide report can tell a failure in
 * the configured workflow apart from one in components the user never set up.
 */
export interface DoctorConfiguredScopeReport {
  readonly clients: readonly string[];
  readonly providers: readonly string[];
  readonly skill: boolean;
  readonly healthy: boolean;
  /** The exact, unquoted arguments of the doctor invocation for this scope. */
  readonly argv: readonly string[];
  /** `argv` quoted for this host's shell: PowerShell on Windows, POSIX elsewhere. */
  readonly command: string;
  /** The checks that make this scope unhealthy; empty when it is healthy. */
  readonly failing_checks: readonly DoctorCheck[];
}

/** Clients and providers this host has set up; absent when none is. */
export interface DoctorConfiguredSelection {
  readonly clients: readonly string[];
  readonly providers: readonly string[];
}

/**
 * Select registered clients (any state except missing or manual) and
 * configured or discovered providers.
 */
export const selectConfiguredDoctorScope = (
  input: Pick<DoctorScopeInput, "registrations" | "providers">,
): DoctorConfiguredSelection | undefined => {
  const clients = uniqueSorted(
    input.registrations
      .filter(({ state }) => state !== "missing" && state !== "manual")
      .map(({ client }) => client),
  );
  const providers = uniqueSorted([
    ...(input.providers.providerInspections ?? [])
      .filter(({ configured }) => configured)
      .map(({ id }) => id),
    // Select by presence, not readiness, so a found but failing Hopper stays
    // in the workflow and its failure stays visible.
    ...(input.providers.hopperConfigured ||
    input.providers.hopperDiscovered === true
      ? ["hopper"]
      : []),
  ]);
  return clients.length === 0 && providers.length === 0
    ? undefined
    : { clients, providers };
};

/**
 * Judge a configured selection as `rea doctor` would for its explicit scope.
 * `skillState` and the `skill:identity` check must come from the skill copies
 * of the selected clients, which the explicit scope reads, not from the
 * audit's read of every installed copy.
 */
export const configuredDoctorScope = (
  input: Omit<DoctorScopeInput, "scope"> & {
    readonly selection: DoctorConfiguredSelection;
    readonly target: string | null;
    /** Whether any selected skill copy exists, including a partial install. */
    readonly skillInstalled: boolean;
    readonly platform: NodeJS.Platform;
    /** How this process was launched: `rea`, or `npx`/`bunx rea-agents`. */
    readonly launcher: readonly string[];
  },
): DoctorConfiguredScopeReport => {
  const { clients, providers } = input.selection;
  const skill = input.skillInstalled;
  const scope: DoctorScopeReport = {
    mode: "explicit",
    clients,
    providers,
    skill,
    target: input.target,
  };
  const argv = [
    ...input.launcher,
    "doctor",
    ...clients.flatMap((client) => ["--client", client]),
    ...providers.flatMap((provider) => ["--provider", provider]),
    ...(skill ? ["--skill"] : []),
    ...(input.target === null ? [] : ["--target", input.target]),
  ];
  const judged = scopeDoctorChecks({ ...input, scope });
  return {
    clients,
    providers,
    skill,
    healthy: judged.healthy,
    argv,
    command: argv
      .map((argument) => shellArgument(argument, input.platform))
      .join(" "),
    failing_checks: judged.scopeChecks.filter(({ ok }) => !ok),
  };
};

/**
 * Quote one argument only when it needs it: single quotes with doubled quotes
 * for PowerShell, REA's documented Windows shell, or POSIX escaping elsewhere.
 * PowerShell also gives a leading `@` (splatting, `@()`, `@{}`) and `,` (array
 * construction) special meaning in argument mode, so those are quoted there.
 */
const shellArgument = (value: string, platform: NodeJS.Platform): string => {
  if (platform === "win32")
    return /^(?!@)[\w./:@%+=-]+$/u.test(value)
      ? value
      : `'${value.replaceAll("'", "''")}'`;
  return /^[\w./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
};

/** Normalize a caller-selected doctor readiness boundary. */
export const normalizeDoctorScope = (
  requested: DoctorScope | undefined,
  target: string | undefined,
): DoctorScopeReport => ({
  mode: requested === undefined ? "audit-wide" : "explicit",
  clients: uniqueSorted(requested?.clients ?? []),
  ...(requested?.skillClients === undefined
    ? {}
    : { skill_clients: uniqueSorted(requested.skillClients) }),
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
      name === "node" || (input.scope.target !== null && name === "target"),
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
  const selectedProviderChecks = input.scope.providers.flatMap((providerId) =>
    selectedProviderChecksFor(providerId, providerChecks, input.providers),
  );
  const hopperHostChecks = input.scope.providers.includes("hopper")
    ? input.checks.filter(({ name }) => name === "host")
    : [];
  // parseConfig rejects these before the MCP server starts. Hopper's own
  // scope already includes hopper-startup-timeout through its provider checks.
  const blocksMcpStartup = (check: DoctorCheck): boolean =>
    check.name.startsWith("runtime-configuration:") ||
    check.name === "hopper-startup-timeout";
  const blocksProcess = (check: DoctorCheck): boolean => {
    const setting = check.details?.setting;
    return (
      check.name.startsWith("runtime-configuration:") &&
      typeof setting === "string" &&
      blocksProcessStart(setting)
    );
  };
  const exercisesMcpStartup =
    input.scope.clients.length > 0 || input.scope.providers.length > 0;
  const startupChecks = (
    exercisesMcpStartup
      ? input.checks.filter(blocksMcpStartup)
      : input.checks.filter(blocksProcess)
  ).filter(
    (check) =>
      check.name !== "hopper-startup-timeout" ||
      !input.scope.providers.includes("hopper"),
  );
  const scopeChecks = [
    ...coreChecks,
    ...startupChecks,
    ...hopperHostChecks,
    ...selectedProviderChecks,
    ...clientChecks,
    ...skillChecks,
  ];
  const selectedNames = new Set(scopeChecks.map(({ name }) => name));
  return {
    healthy:
      coreChecks.every(({ ok }) => ok) &&
      startupChecks.every(({ ok }) => ok) &&
      hopperHostChecks.every(({ ok }) => ok) &&
      clientChecks.every(({ ok }) => ok) &&
      skillChecks.every(({ ok }) => ok) &&
      selectedProviderChecks.every(({ ok }) => ok),
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
): DoctorCheck => {
  const manual = manualRegistrationRemediation(client);
  if (status === undefined && manual !== undefined)
    return {
      name: `registration:${client}`,
      ok: false,
      classification: "config_drift",
      detail: `${client} is not registered through a local configuration file.`,
      remediation: manual,
    };
  return status === undefined
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
};

const registrationCheck = (
  status: UnhealthyClientRegistrationStatus,
): DoctorCheck => ({
  name: `registration:${status.client}`,
  ok: false,
  classification: status.state === "unknown" ? "unknown" : "config_drift",
  detail: status.config_path,
  remediation: status.remediation,
});

const selectedSkillCheck = (
  state: DoctorScopeInput["skillState"],
  checks: readonly DoctorCheck[],
): DoctorCheck =>
  checks.find(({ name }) => name === "skill:identity") ?? {
    name: "skill:identity",
    ok: state === "aligned",
    classification:
      state === "aligned"
        ? "healthy"
        : state === "unknown"
          ? "unknown"
          : "config_drift",
    ...(state === "aligned"
      ? { detail: "Installed REA skill identity is aligned." }
      : {
          remediation:
            state === "unmanaged"
              ? "Use regular skill directories, or run rea setup with --skill=false to configure the client without installing the skill."
              : state === "unknown"
                ? "Verify access to the reported skill files before retrying."
                : "Run rea setup to update the installed REA skill.",
        }),
  };

const doctorProviderCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
