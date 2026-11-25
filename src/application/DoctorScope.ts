import { uniqueSorted } from "../domain/canonicalOrdering.js";
import { blocksProcessStart } from "../config/processStart.js";
import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import { manualRegistrationRemediation } from "./SupportedClients.js";
import { isDesktopBuildInformationalCheck } from "./DesktopBuildDoctor.js";
import {
  DESKTOP_BUILD_PROVIDER_ID,
  isDesktopBuildCheck,
} from "../domain/doctorProviderIds.js";
import type { DoctorScope, DoctorSkillState } from "./Doctor.js";
import type {
  DoctorCheck,
  DoctorProviderInspection,
} from "../ports/DoctorProviderInspection.js";

/** Normalized readiness boundary included in every doctor response. */
export interface DoctorScopeReport {
  readonly mode: "audit-wide" | "explicit";
  readonly clients: readonly string[];
  readonly skill_clients?: readonly string[];
  readonly providers: readonly string[];
  readonly skill: boolean;
  readonly target: string | null;
}

/** Provider facts that decide which providers a scope can select. */
export interface DoctorProviderState {
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

/** Clients and providers this host has set up. */
export interface DoctorConfiguredSelection {
  readonly clients: readonly string[];
  readonly providers: readonly string[];
}

/**
 * Select the registered clients with the configured or discovered providers;
 * absent when nothing is set up. Hopper is selected by presence, not
 * readiness, so a found but failing Hopper stays visible.
 */
export const selectConfiguredDoctorScope = (
  clients: readonly string[],
  providers: DoctorProviderState,
): DoctorConfiguredSelection | undefined => {
  const selectedProviders = uniqueSorted([
    ...(providers.providerInspections ?? [])
      .filter(({ configured }) => configured)
      .map(({ id }) => id),
    ...(providers.hopperConfigured || providers.hopperDiscovered === true
      ? ["hopper"]
      : []),
  ]);
  return clients.length === 0 && selectedProviders.length === 0
    ? undefined
    : { clients: uniqueSorted(clients), providers: selectedProviders };
};

/**
 * Judge a configured selection as `rea doctor` judges its explicit scope. The
 * facts must be the ones that scope collects, including the skill copies of
 * the selected clients rather than every installed copy.
 */
export const configuredDoctorScope = (
  input: Omit<DoctorScopeInput, "scope"> & {
    readonly selection: DoctorConfiguredSelection;
    readonly target: string | null;
    /** Whether any selected skill copy exists, including a partial install. */
    readonly skillInstalled: boolean;
    readonly platform: NodeJS.Platform;
    /** How this process was launched: `rea`, or a pinned `npx`/`bunx` package. */
    readonly launcher: readonly string[];
  },
): DoctorConfiguredScopeReport => {
  const { clients, providers } = input.selection;
  const skill = input.skillInstalled;
  const judged = scopeDoctorChecks({
    ...input,
    scope: {
      mode: "explicit",
      clients,
      providers,
      skill,
      target: input.target,
    },
  });
  const argv = [
    ...input.launcher,
    "doctor",
    ...clients.flatMap((client) => ["--client", client]),
    ...providers.flatMap((provider) => ["--provider", provider]),
    ...(skill ? ["--skill"] : []),
    // Attached, so a flag-shaped path such as `--json` or PowerShell's
    // stop-parsing `--%` stays the option's value rather than a token.
    ...(input.target === null ? [] : [`--target=${input.target}`]),
  ];
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
  const clientChecks = input.scope.clients.map((client) => {
    const status = input.registrations.find(
      (candidate) => candidate.client === client,
    );
    return status === undefined
      ? undetectedRegistrationCheck(client)
      : clientRegistrationCheck(status);
  });
  const environmentChecks = input.checks.filter((check) =>
    registrationEnvironmentInScope(check, input.scope),
  );
  const skillChecks = input.scope.skill
    ? [selectedSkillCheck(input.skillState, input.checks)]
    : [];
  const selectedProviderChecks = input.scope.providers.flatMap((providerId) =>
    providerId === DESKTOP_BUILD_PROVIDER_ID
      ? requiredDesktopBuildChecks(input.checks)
      : selectedProviderChecksFor(providerId, providerChecks, input.providers),
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
    ...environmentChecks,
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

/** Follow the caller's question: a named client, or a provider it relies on. */
const registrationEnvironmentInScope = (
  { name, details }: DoctorCheck,
  scope: DoctorScopeReport,
): boolean => {
  const [family, client] = name.split(":");
  if (family !== "registration_environment" || client === undefined)
    return false;
  const providers = details?.providers;
  return (
    scope.clients.includes(client) ||
    (Array.isArray(providers) &&
      scope.providers.some((provider) => providers.includes(provider)))
  );
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

/** Informational desktop build checks stay outside the scope that decides health. */
const requiredDesktopBuildChecks = (
  checks: readonly DoctorCheck[],
): readonly DoctorCheck[] => {
  const required = checks.filter(
    ({ name }) =>
      isDesktopBuildCheck(name) && !isDesktopBuildInformationalCheck(name),
  );
  return required.length > 0
    ? required
    : [
        {
          name: `provider:${DESKTOP_BUILD_PROVIDER_ID}`,
          ok: false,
          classification: "unknown",
          detail: "This doctor host does not check desktop build hosts.",
          remediation: "Run rea doctor --provider desktop_build from the CLI.",
        },
      ];
};

const undetectedRegistrationCheck = (client: string): DoctorCheck => {
  const manual = manualRegistrationRemediation(client);
  return {
    name: `registration:${client}`,
    ok: false,
    classification: "config_drift",
    detail:
      manual === undefined
        ? `Requested client ${client} was not detected.`
        : `${client} is not registered through a local configuration file.`,
    remediation:
      manual ??
      `Install or select ${client}, then run rea setup --client ${client}.`,
  };
};

/** Project a detected registration for either an explicit client check or an audit. */
export const clientRegistrationCheck = (
  status: ClientRegistrationStatus,
): DoctorCheck => {
  const aligned = status.state === "aligned";
  return {
    name: `registration:${status.client}`,
    ok: aligned,
    classification: aligned
      ? "healthy"
      : status.state === "unknown"
        ? "unknown"
        : "config_drift",
    detail: status.config_path,
    ...(status.scope === undefined ? {} : { details: { scope: status.scope } }),
    ...(aligned ? {} : { remediation: status.remediation }),
  };
};

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
