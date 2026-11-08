import { constants } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { parse as parseToml } from "smol-toml";

import type {
  DesktopBuildCommand,
  DesktopBuildFacts,
  DesktopBuildFactsInput,
} from "../application/DesktopBuildDoctor.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  readRegularFileText,
  RetainedRegularFileCleanupFailure,
} from "../application/RegularFileRead.js";
import { DESKTOP_EXPORT_FRAMEWORK_VERSION } from "../domain/desktop/appExport.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { execFileOutputFailure } from "../process/ExecFileOutput.js";
import {
  agentEnvReportedVersion,
  BUILD_COMPUTER_SETTINGS,
  defaultBuildComputerArchive,
  programOnPath,
  resolveBuildComputerProgram,
  type BuildComputerSetting,
} from "./BuildComputerEnvironment.js";

const DEFAULT_DOCKER_ROOT = "/var/lib/docker";
const CONFIG_BYTES = 1024 * 1024;

/** Read what a desktop build needs from this host, changing nothing. */
export const readDesktopBuildFacts = async (
  input: DesktopBuildFactsInput,
): Promise<DesktopBuildFacts> => {
  const { environment } = input;
  const docker = await settingCommand(
    environment,
    "REA_DOCKER_COMMAND",
    "docker",
  );
  const daemon =
    docker.status === "found"
      ? await dockerDaemon(input, docker.path)
      : ({ status: "unchecked" } as const);
  const agentEnv = await settingCommand(
    environment,
    "REA_AGENT_ENV_COMMAND",
    "agent-env",
  );
  const versions = new Map<string, Promise<string | undefined>>();
  const versionFor = (path: string): Promise<string | undefined> => {
    const existing = versions.get(path);
    if (existing !== undefined) return existing;
    const pending = agentEnvVersion(input, path);
    versions.set(path, pending);
    return pending;
  };
  const archive = await archiveFact(input);
  const chosenCommand = (
    name: BuildComputerSetting,
    command: DesktopBuildCommand,
  ) =>
    (environment[name] ?? "") !== ""
      ? environment[name]
      : command.status === "found"
        ? command.path
        : undefined;
  const selectedDocker = chosenCommand("REA_DOCKER_COMMAND", docker);
  const selectedAgentEnv = chosenCommand("REA_AGENT_ENV_COMMAND", agentEnv);
  const selectedSettings: Partial<Record<BuildComputerSetting, string>> = {
    ...(selectedDocker === undefined
      ? {}
      : { REA_DOCKER_COMMAND: selectedDocker }),
    ...(selectedAgentEnv === undefined
      ? {}
      : { REA_AGENT_ENV_COMMAND: selectedAgentEnv }),
    REA_BUILD_COMPUTER_REA_ARCHIVE: archive.path,
  };
  return {
    ps: await psFact(input),
    docker,
    daemon,
    disk: await freeSpace(
      daemon.status === "reachable"
        ? daemon.rootDirectory
        : DEFAULT_DOCKER_ROOT,
    ),
    agentEnv:
      agentEnv.status === "found"
        ? { ...agentEnv, version: await versionFor(agentEnv.path) }
        : agentEnv,
    archive,
    registrations: await registrationFacts(input, selectedSettings, versionFor),
    environmentSettings: BUILD_COMPUTER_SETTINGS.filter(
      (name) => (environment[name] ?? "") !== "",
    ),
    solveEndpoint: await solveEndpoint(input),
    leftoverContainers:
      docker.status === "found" && daemon.status === "reachable"
        ? await leftoverContainers(input, docker.path)
        : undefined,
  };
};

/** Run a bounded command; undefined output with its stderr when it fails. */
const attempt = async (
  input: DesktopBuildFactsInput,
  command: string,
  arguments_: readonly string[],
): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: string }
> => {
  try {
    const { stdout } = await input.run(command, arguments_, {
      env: input.environment,
    });
    return { ok: true, stdout };
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) throw cause;
    const failure = execFileOutputFailure(cause);
    const stderr = failure?.stderr.trim() ?? "";
    return {
      ok: false,
      reason:
        stderr === ""
          ? cause instanceof Error
            ? cause.message
            : String(cause)
          : stderr,
    };
  }
};

const executable = (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    async () => (await stat(path)).isFile(),
    () => false,
  );

const settingCommand = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: BuildComputerSetting,
  program: string,
): Promise<DesktopBuildCommand> => {
  const value = environment[name];
  if (value === undefined || value === "") {
    const path = await programOnPath(program, environment);
    return path === undefined
      ? { status: "missing" }
      : { status: "found", path, source: "path" };
  }
  return isAbsolute(value) && (await executable(value))
    ? { status: "found", path: value, source: "environment" }
    : { status: "invalid", value };
};

/** procps `ps` accepts `-p`; busybox's does not. */
const psFact = async (
  input: DesktopBuildFactsInput,
): Promise<DesktopBuildFacts["ps"]> => {
  const ps = await programOnPath("ps", input.environment);
  if (ps === undefined) return { found: false, detail: "No ps is on PATH." };
  const probe = await attempt(input, ps, [
    "-o",
    "pid=",
    "-p",
    String(process.pid),
  ]);
  return probe.ok
    ? { found: true, detail: ps }
    : {
        found: false,
        detail: `${ps} is not procps-compatible: ${probe.reason}`,
      };
};

const dockerDaemon = async (
  input: DesktopBuildFactsInput,
  docker: string,
): Promise<DesktopBuildFacts["daemon"]> => {
  const info = await attempt(input, docker, [
    "info",
    "--format",
    "{{.DockerRootDir}}",
  ]);
  if (info.ok)
    return {
      status: "reachable",
      rootDirectory: info.stdout.trim() || DEFAULT_DOCKER_ROOT,
    };
  return {
    status: /permission denied/iu.test(info.reason)
      ? "permission_denied"
      : "unreachable",
    detail: info.reason,
  };
};

/** Free space on the filesystem that holds `path`, or its nearest existing parent. */
const freeSpace = async (path: string): Promise<DesktopBuildFacts["disk"]> => {
  let candidate = path;
  for (;;) {
    try {
      const fs = await statfs(candidate);
      return { path: candidate, freeBytes: fs.bavail * fs.bsize };
    } catch (cause: unknown) {
      const parent = dirname(candidate);
      if (parent === candidate)
        return {
          path,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      candidate = parent;
    }
  }
};

const agentEnvVersion = async (
  input: DesktopBuildFactsInput,
  agentEnv: string,
): Promise<string | undefined> => {
  const reported = await attempt(input, agentEnv, ["--version"]);
  return reported.ok ? agentEnvReportedVersion(reported.stdout) : undefined;
};

/** The setup-packed archive is named by its version; another is read for its package version. */
const archiveFact = async (
  input: DesktopBuildFactsInput,
): Promise<DesktopBuildFacts["archive"]> => {
  const selected = input.environment.REA_BUILD_COMPUTER_REA_ARCHIVE;
  const source =
    selected === undefined || selected === "" ? "cache" : "environment";
  const path =
    source === "cache"
      ? defaultBuildComputerArchive(input.environment, input.platform)
      : (selected as string);
  const file = await stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );
  if (!file) return { path, source, status: "missing" };
  if (source === "cache") return { path, source, status: "current" };
  const packed = await attempt(input, "tar", [
    "-xJOf",
    path,
    "rea-prod/package.json",
  ]);
  if (!packed.ok)
    return {
      path,
      source,
      status: "unknown",
      detail: `REA could not read rea-prod/package.json from ${path}: ${packed.reason}`,
    };
  let version: unknown;
  try {
    version = (JSON.parse(packed.stdout) as { version?: unknown }).version;
  } catch {
    version = undefined;
  }
  return version === PRODUCT_IDENTITY.packageVersion
    ? { path, source, status: "current" }
    : {
        path,
        source,
        status: "stale",
        detail: `${path} holds REA ${typeof version === "string" ? version : "of an unknown version"}; this is REA ${PRODUCT_IDENTITY.packageVersion}.`,
      };
};

/** Setting names each considered registration records; values stay in its file. */
const registrationFacts = async (
  input: DesktopBuildFactsInput,
  selectedSettings: Partial<Record<BuildComputerSetting, string>>,
  versionFor: (path: string) => Promise<string | undefined>,
): Promise<DesktopBuildFacts["registrations"]> => {
  const selected = input.clientIds.length === 0 ? undefined : input.clientIds;
  const recordedRunners = new Map<string, string>();
  const statuses = await input.registrations(
    selected,
    Object.fromEntries(
      BUILD_COMPUTER_SETTINGS.map((name) => [
        name,
        selectedSettings[name] ?? "",
      ]),
    ),
    undefined,
    (client, name, value) => {
      if (
        name === "REA_AGENT_ENV_COMMAND" &&
        (selected === undefined || selected.includes(client))
      )
        recordedRunners.set(client, value);
    },
  );
  const registered = statuses.filter(({ command }) => command.length > 0);
  const considered = selected ?? registered.map(({ client }) => client);
  return Promise.all(
    considered.map(async (client) => {
      const status = registered.find((entry) => entry.client === client);
      const recordedRunner =
        status === undefined ? undefined : recordedRunners.get(client);
      const effectiveRunner =
        recordedRunner === undefined
          ? undefined
          : await resolveBuildComputerProgram(
              recordedRunner,
              "agent-env",
              input.environment,
            );
      let runner: DesktopBuildFacts["registrations"][number]["runner"];
      if (recordedRunner !== undefined) {
        if (
          effectiveRunner === undefined ||
          !isAbsolute(effectiveRunner) ||
          !(await executable(effectiveRunner))
        )
          runner = { status: "invalid" };
        else {
          const version = await versionFor(effectiveRunner);
          runner =
            version === undefined
              ? { status: "unknown" }
              : {
                  status:
                    version === DESKTOP_EXPORT_FRAMEWORK_VERSION
                      ? "current"
                      : "stale",
                  version,
                };
        }
      }
      const differing = (status?.provider_settings?.differing ?? []).filter(
        (name) =>
          name !== "REA_AGENT_ENV_COMMAND" ||
          recordedRunner !== "" ||
          effectiveRunner === undefined ||
          effectiveRunner !== selectedSettings.REA_AGENT_ENV_COMMAND,
      );
      const compared = differing.filter(
        (name) => selectedSettings[name as BuildComputerSetting] !== undefined,
      );
      const unchecked = differing.filter(
        (name) =>
          selectedSettings[name as BuildComputerSetting] === undefined &&
          !(name === "REA_AGENT_ENV_COMMAND" && runner !== undefined),
      );
      return {
        client,
        registered: status !== undefined,
        unrecorded: status?.provider_settings?.unrecorded ?? [],
        unresolved: status?.provider_settings?.unresolved ?? [],
        ...(compared.length === 0 ? {} : { differing: compared }),
        ...(unchecked.length === 0 ? {} : { unchecked }),
        ...(runner === undefined ? {} : { runner }),
      };
    }),
  );
};

const solveEndpoint = async (
  input: DesktopBuildFactsInput,
): Promise<string | undefined> => {
  const { environment, platform } = input;
  if (
    (environment.LITELLM_BASE_URL ?? "") !== "" &&
    (environment.LITELLM_API_KEY ?? "") !== ""
  )
    return "LITELLM_BASE_URL and LITELLM_API_KEY";
  const home = homeDirectoryFromEnvironment(environment, platform);
  for (const path of [
    environment.AGENT_ENV_CONFIG,
    join(process.cwd(), ".agentenv/config.toml"),
    join(home, ".agentenv/config.toml"),
  ])
    if (path !== undefined && path !== "" && (await hasModelTable(path, input)))
      return path;
  return undefined;
};

const hasModelTable = async (
  path: string,
  input: DesktopBuildFactsInput,
): Promise<boolean> => {
  try {
    if (input.signal.aborted)
      throw new AnalysisCancelledError("doctor", {
        cause: input.signal.reason,
      });
    const candidate = await stat(path);
    if (input.signal.aborted)
      throw new AnalysisCancelledError("doctor", {
        cause: input.signal.reason,
      });
    if (!candidate.isFile() || candidate.size > CONFIG_BYTES) return false;
    const text = await readRegularFileText(path, {
      signal: input.signal,
      admit: (state) => {
        if (state.size > CONFIG_BYTES)
          throw new Error("Configuration exceeds the read limit");
      },
      cancellationFailure: (reason) =>
        new AnalysisCancelledError("doctor", { cause: reason }),
    });
    const model: unknown = parseToml(text).model;
    return typeof model === "object" && model !== null;
  } catch (cause: unknown) {
    if (cause instanceof RetainedRegularFileCleanupFailure) {
      input.resources.retain(cause.cleanupOwner);
      throw cause;
    }
    if (cause instanceof AnalysisCancelledError) throw cause;
    if (input.signal.aborted)
      throw new AnalysisCancelledError("doctor", {
        cause: input.signal.reason,
      });
    return false;
  }
};

/** Sandboxes agentenv runs as `agent-<id>`, and those it labels with their id. */
const leftoverContainers = async (
  input: DesktopBuildFactsInput,
  docker: string,
): Promise<readonly string[] | undefined> => {
  const names = new Set<string>();
  for (const filter of ["name=^agent-", "label=agentenv.sandbox"]) {
    const listed = await attempt(input, docker, [
      "ps",
      "-a",
      "--filter",
      filter,
      "--format",
      "{{.Names}}",
    ]);
    if (!listed.ok) return undefined;
    for (const name of listed.stdout.split(/\s+/u).filter(Boolean))
      names.add(name);
  }
  return [...names].sort();
};
