import { DESKTOP_EXPORT_FRAMEWORK_VERSION } from "../domain/desktop/appExport.js";
import type { execFileOutput } from "../process/ExecFileOutput.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import type { DoctorCheck, DoctorHost, DoctorSkillState } from "./Doctor.js";
import { nodeCheck } from "./DoctorDiagnostics.js";
import { DESKTOP_BUILD_PROVIDER_ID } from "./DoctorProviderIds.js";
import type { DoctorScopeReport } from "./DoctorScope.js";

/** Free space agentenv's images need where Docker keeps them. */
export const DESKTOP_BUILD_MIN_FREE_BYTES = 20 * 1000 ** 3;

/** The command that installs the agentenv-framework release bundles target. */
export const AGENTENV_INSTALL_COMMAND = `uv tool install agentenv-framework==${DESKTOP_EXPORT_FRAMEWORK_VERSION}`;

/** How a build setting's program was found: set in the environment, or on PATH. */
export type DesktopBuildCommand =
  | {
      readonly status: "found";
      readonly path: string;
      readonly source: "environment" | "path";
    }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly value: string };

/** What a desktop build host has, read without changing anything. */
export interface DesktopBuildFacts {
  readonly ps: { readonly found: boolean; readonly detail: string };
  readonly docker: DesktopBuildCommand;
  readonly daemon:
    | { readonly status: "reachable"; readonly rootDirectory: string }
    | {
        readonly status: "permission_denied" | "unreachable";
        readonly detail: string;
      }
    | { readonly status: "unchecked" };
  readonly disk:
    | { readonly path: string; readonly freeBytes: number }
    | { readonly path: string; readonly error: string };
  readonly agentEnv: DesktopBuildCommand & {
    readonly version?: string | undefined;
  };
  readonly archive: {
    readonly path: string;
    readonly source: "environment" | "cache";
    readonly status: "current" | "missing" | "stale" | "unknown";
    readonly detail?: string;
  };
  /** Each considered client's registration, by setting names only. */
  readonly registrations: readonly {
    readonly client: string;
    readonly registered: boolean;
    readonly unrecorded: readonly string[];
    readonly unresolved: readonly string[];
    readonly differing?: readonly string[];
    readonly unchecked?: readonly string[];
    /** Version check of this client's recorded runner, without the recorded path. */
    readonly runner?: {
      readonly status: "current" | "stale" | "invalid" | "unknown";
      readonly version?: string;
    };
  }[];
  /** Build settings this terminal's environment sets. */
  readonly environmentSettings: readonly string[];
  /** Where a solve endpoint is configured, if anywhere. */
  readonly solveEndpoint: string | undefined;
  /** Names of agentenv sandbox containers; undefined when Docker was not reachable. */
  readonly leftoverContainers: readonly string[] | undefined;
}

/** What a facts reader gets from doctor: its environment, bounded runner and registration reader. */
export interface DesktopBuildFactsInput {
  readonly signal: AbortSignal;
  readonly resources: ArtifactResourceScope;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly run: typeof execFileOutput;
  readonly clientIds: readonly string[];
  readonly registrations: (
    clientIds: readonly string[] | undefined,
    settings: Readonly<Record<string, string>>,
    owned?: undefined,
    observe?: (client: string, name: string, value: string) => void,
  ) => Promise<readonly ClientRegistrationStatus[]>;
}

/** What doctor already knows that the build checks reuse. */
export interface DesktopBuildContext {
  readonly host: Pick<DoctorHost, "platform" | "architecture" | "runtime">;
  readonly clients: readonly string[];
  readonly skill: {
    readonly state: DoctorSkillState;
    readonly remediation: string | null;
  };
}

const INFORMATIONAL = new Set([
  `${DESKTOP_BUILD_PROVIDER_ID}-solve-endpoint`,
  `${DESKTOP_BUILD_PROVIDER_ID}-leftover-containers`,
]);

/** Whether a desktop build check reports without deciding health. */
export const isDesktopBuildInformationalCheck = (name: string): boolean =>
  INFORMATIONAL.has(name);

const named = (name: string) => `${DESKTOP_BUILD_PROVIDER_ID}-${name}`;

const result = (
  name: string,
  ok: boolean,
  detail: string,
  outcome: {
    readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
    readonly remediation: string;
    readonly details?: DoctorCheck["details"];
  },
): DoctorCheck => ({
  name: named(name),
  ok,
  classification: ok ? "healthy" : outcome.classification,
  detail,
  ...(outcome.details === undefined ? {} : { details: outcome.details }),
  ...(ok ? {} : { remediation: outcome.remediation }),
});

/** The desktop build checks a doctor scope selects, read through its host. */
export const selectedDesktopBuildChecks = async (
  host: DoctorHost,
  scope: DoctorScopeReport,
  skill: DesktopBuildContext["skill"],
): Promise<readonly DoctorCheck[]> =>
  scope.providers.includes(DESKTOP_BUILD_PROVIDER_ID) &&
  host.desktopBuildFacts !== undefined
    ? desktopBuildChecks(await host.desktopBuildFacts(scope.clients), {
        host,
        clients: scope.clients,
        skill,
      })
    : [];

const setupCommand = (clients: readonly string[]): string =>
  clients.length === 1
    ? `rea setup --client ${clients[0]} --desktop-build`
    : "rea setup --client <client> --desktop-build";

/** The desktop build checks, required first and informational last. */
export const desktopBuildChecks = (
  facts: DesktopBuildFacts,
  context: DesktopBuildContext,
): readonly DoctorCheck[] => [
  hostCheck(context.host),
  { ...nodeCheck(context.host), name: named("node") },
  result("ps", facts.ps.found, facts.ps.detail, {
    classification: "missing_dependency",
    remediation:
      "Install procps, whose ps REA's process supervisor runs: sudo apt install procps.",
  }),
  dockerCheck(facts.docker),
  daemonCheck(facts.daemon),
  diskCheck(facts.disk),
  agentEnvCheck(facts),
  archiveCheck(facts.archive, context.clients),
  registrationCheck(facts, context.clients),
  skillCheck(context.skill),
  solveEndpointCheck(facts.solveEndpoint),
  leftoverContainersCheck(facts.leftoverContainers),
];

const hostCheck = (host: DesktopBuildContext["host"]): DoctorCheck =>
  result(
    "host",
    host.platform === "linux" &&
      (host.architecture === "x64" || host.architecture === "arm64"),
    `${host.platform} ${host.architecture}`,
    {
      classification: "unsupported_host",
      remediation:
        "Builds run on a Linux host on amd64 or arm64 and target its own architecture; run REA on such a host.",
    },
  );

const commandDetail = (command: DesktopBuildCommand, name: string): string =>
  command.status === "found"
    ? `${command.path} (${command.source === "environment" ? name : "PATH"})`
    : command.status === "invalid"
      ? `${name}=${command.value} is not an absolute path to a program.`
      : `${name} is unset and none is on PATH.`;

const dockerCheck = (docker: DesktopBuildCommand): DoctorCheck =>
  result(
    "docker",
    docker.status === "found",
    commandDetail(docker, "REA_DOCKER_COMMAND"),
    {
      classification:
        docker.status === "invalid" ? "config_drift" : "missing_dependency",
      remediation:
        docker.status === "invalid"
          ? "Set REA_DOCKER_COMMAND to the absolute path of the Docker CLI, or unset it to use docker on PATH."
          : "Install Docker Engine: https://docs.docker.com/engine/install/",
    },
  );

const daemonCheck = (daemon: DesktopBuildFacts["daemon"]): DoctorCheck =>
  result(
    "docker-daemon",
    daemon.status === "reachable",
    daemon.status === "reachable"
      ? `Docker keeps its data in ${daemon.rootDirectory}.`
      : daemon.status === "unchecked"
        ? "Not checked without a Docker CLI."
        : daemon.detail,
    daemon.status === "unreachable"
      ? {
          classification: "runtime_failure",
          remediation:
            "Start Docker (sudo systemctl start docker), then rerun rea doctor --provider desktop_build.",
        }
      : {
          classification: "config_drift",
          remediation:
            "Let your user reach Docker without sudo: sudo usermod -aG docker $USER, then log out and in again.",
        },
  );

const diskCheck = (disk: DesktopBuildFacts["disk"]): DoctorCheck => {
  const gb = (bytes: number) => `${(bytes / 1000 ** 3).toFixed(1)} GB`;
  return "error" in disk
    ? result("disk", false, `${disk.path}: ${disk.error}`, {
        classification: "unknown",
        remediation: `Check that ${disk.path} is readable, then rerun rea doctor --provider desktop_build.`,
      })
    : result(
        "disk",
        disk.freeBytes >= DESKTOP_BUILD_MIN_FREE_BYTES,
        `${gb(disk.freeBytes)} free in ${disk.path}.`,
        {
          classification: "missing_dependency",
          remediation: `Free at least ${gb(DESKTOP_BUILD_MIN_FREE_BYTES)} in ${disk.path}, or move Docker's data root (data-root in /etc/docker/daemon.json) to a larger disk.`,
          details: { path: disk.path, free_bytes: disk.freeBytes },
        },
      );
};

const agentEnvCheck = (facts: DesktopBuildFacts): DoctorCheck => {
  const { agentEnv } = facts;
  const clients = facts.registrations.filter(({ registered }) => registered);
  if (
    clients.some(
      ({ runner, unresolved }) =>
        runner !== undefined || unresolved.includes("REA_AGENT_ENV_COMMAND"),
    )
  ) {
    const rows = clients.map(({ client, runner, unresolved }) => ({
      client,
      ...(runner ??
        (unresolved.includes("REA_AGENT_ENV_COMMAND")
          ? { status: "unknown" as const }
          : agentEnv.status !== "found"
            ? { status: "invalid" as const }
            : agentEnv.version === undefined
              ? { status: "unknown" as const }
              : {
                  status:
                    agentEnv.version === DESKTOP_EXPORT_FRAMEWORK_VERSION
                      ? ("current" as const)
                      : ("stale" as const),
                  version: agentEnv.version,
                })),
    }));
    const healthy = rows.every(({ status }) => status === "current");
    return result(
      "agent-env",
      healthy,
      rows
        .map(({ client, status }) => `${client}'s runner is ${status}.`)
        .join(" "),
      {
        classification: rows.some(({ status }) => status === "unknown")
          ? "unknown"
          : "missing_dependency",
        remediation: `${AGENTENV_INSTALL_COMMAND}, or rea setup --desktop-build --install-agentenv.`,
        details: {
          expected_version: DESKTOP_EXPORT_FRAMEWORK_VERSION,
          clients: rows,
        },
      },
    );
  }
  const pinned = agentEnv.version === DESKTOP_EXPORT_FRAMEWORK_VERSION;
  const detail =
    agentEnv.status !== "found"
      ? commandDetail(agentEnv, "REA_AGENT_ENV_COMMAND")
      : `${commandDetail(agentEnv, "REA_AGENT_ENV_COMMAND")} reports ${agentEnv.version === undefined ? "no version" : `agentenv-framework ${agentEnv.version}`}; bundles target ${DESKTOP_EXPORT_FRAMEWORK_VERSION}.`;
  return result("agent-env", agentEnv.status === "found" && pinned, detail, {
    classification:
      agentEnv.status === "invalid" ? "config_drift" : "missing_dependency",
    remediation:
      agentEnv.status === "invalid"
        ? `Set REA_AGENT_ENV_COMMAND to the absolute path of agent-env, or unset it to use agent-env on PATH. To install it: ${AGENTENV_INSTALL_COMMAND}`
        : `${AGENTENV_INSTALL_COMMAND}, or rea setup --desktop-build --install-agentenv.`,
    details: { expected_version: DESKTOP_EXPORT_FRAMEWORK_VERSION },
  });
};

const archiveCheck = (
  archive: DesktopBuildFacts["archive"],
  clients: readonly string[],
): DoctorCheck =>
  result(
    "archive",
    archive.status === "current",
    archive.detail ??
      (archive.status === "current"
        ? `${archive.path} holds this REA version.`
        : `${archive.path} is missing.`),
    {
      classification: archive.status === "unknown" ? "unknown" : "config_drift",
      remediation:
        archive.source === "environment"
          ? `Repack it with npm run pack:build-computer-runtime -- ${archive.path}, or unset REA_BUILD_COMPUTER_REA_ARCHIVE and run ${setupCommand(clients)}.`
          : `Run ${setupCommand(clients)} to pack it.`,
      details: { path: archive.path, source: archive.source },
    },
  );

const registrationCheck = (
  facts: DesktopBuildFacts,
  clients: readonly string[],
): DoctorCheck => {
  const set = new Set(facts.environmentSettings);
  const gaps = facts.registrations.map(
    ({
      client,
      registered,
      unrecorded,
      unresolved,
      differing = [],
      unchecked = [],
      runner,
    }) => ({
      client,
      registered,
      missing: unrecorded.filter((name) => !set.has(name)),
      unresolved: [...unresolved],
      ...(differing.length === 0 ? {} : { differing: [...differing] }),
      ...(unchecked.length === 0 ? {} : { unchecked: [...unchecked] }),
      ...(runner === undefined ? {} : { runner }),
    }),
  );
  const failing = gaps.filter(
    ({ registered, missing, differing, runner }) =>
      !registered ||
      missing.length > 0 ||
      (differing ?? []).some(
        (name) =>
          name !== "REA_AGENT_ENV_COMMAND" || runner?.status !== "current",
      ),
  );
  const unknown = gaps.filter(
    ({ unresolved, unchecked }) =>
      unresolved.length > 0 || (unchecked?.length ?? 0) > 0,
  );
  const repair = failing[0]?.client ?? unknown[0]?.client;
  return result(
    "registration",
    gaps.length > 0 && failing.length === 0 && unknown.length === 0,
    gaps.length === 0
      ? "No REA registration was found."
      : gaps.map(registrationDetail).join(" "),
    {
      classification:
        failing.length === 0 && gaps.length > 0 ? "unknown" : "config_drift",
      remediation: `Run ${setupCommand(repair === undefined ? clients : [repair])}, then restart the client.`,
      details: { registrations: gaps },
    },
  );
};

const registrationDetail = (gap: {
  readonly client: string;
  readonly registered: boolean;
  readonly missing: readonly string[];
  readonly unresolved: readonly string[];
  readonly differing?: readonly string[];
  readonly unchecked?: readonly string[];
}): string => {
  if (!gap.registered) return `${gap.client} does not register REA.`;
  const details = [
    ...(gap.missing.length === 0
      ? []
      : [
          `${gap.client}'s registration does not record ${gap.missing.join(", ")}, and this environment does not set them.`,
        ]),
    ...(gap.unresolved.length === 0
      ? []
      : [`REA could not read ${gap.client}'s ${gap.unresolved.join(", ")}.`]),
    ...(gap.differing === undefined
      ? []
      : [
          `${gap.client}'s registration records different values for ${gap.differing.join(", ")}.`,
        ]),
    ...(gap.unchecked === undefined
      ? []
      : [
          `REA did not check ${gap.client}'s recorded ${gap.unchecked.join(", ")} against the paths used in this terminal.`,
        ]),
  ];
  return details.length > 0
    ? details.join(" ")
    : `${gap.client}'s registration records the build settings, or this environment sets them.`;
};

const skillCheck = (skill: DesktopBuildContext["skill"]): DoctorCheck =>
  result(
    "skill",
    skill.state === "aligned",
    `The installed REA skill, with its desktop-build reference, is ${skill.state}.`,
    {
      classification: skill.state === "unknown" ? "unknown" : "config_drift",
      remediation:
        skill.remediation ?? "Run rea setup --skill to update the REA skill.",
    },
  );

const solveEndpointCheck = (where: string | undefined): DoctorCheck =>
  result(
    "solve-endpoint",
    where !== undefined,
    where === undefined
      ? "No model endpoint is configured for solver runs."
      : `Solver runs use the model endpoint in ${where}.`,
    {
      classification: "missing_dependency",
      remediation:
        "For solver runs, export LITELLM_BASE_URL and LITELLM_API_KEY in the shell that starts the agent, or set base_url and api_key under [model] in .agentenv/config.toml.",
    },
  );

const leftoverContainersCheck = (
  containers: readonly string[] | undefined,
): DoctorCheck =>
  result(
    "leftover-containers",
    containers === undefined || containers.length === 0,
    containers === undefined
      ? "Not checked without a reachable Docker daemon."
      : containers.length === 0
        ? "No agentenv sandbox containers are left."
        : `${String(containers.length)} agentenv sandbox containers remain: ${containers.join(", ")}.`,
    {
      classification: "config_drift",
      remediation: `If no build is running, remove them: docker rm -f ${(containers ?? []).join(" ")}`,
    },
  );
