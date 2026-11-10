import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { reaCacheDirectory } from "../config/kunaCacheDirectory.js";
import { appendCallerPath } from "../filesystem/callerPath.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { BUILD_COMPUTER_SETTINGS } from "../domain/desktop/buildComputerSettings.js";
import { resolveProgram } from "./ProgramLookup.js";

/** The settings a build computer reads where the REA server starts. */
export { BUILD_COMPUTER_SETTINGS };

/** One of the build computer's settings. */
export type BuildComputerSetting = (typeof BUILD_COMPUTER_SETTINGS)[number];

/** The REA-owned folder `rea setup --desktop-build` packs runtime archives into. */
export const buildComputerArchiveDirectory = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): string =>
  reaCacheDirectory(
    homeDirectoryFromEnvironment(environment, platform),
    environment,
    platform,
    "build-computer",
  );

/** The runtime archive packed for this REA version, named by that version. */
export const defaultBuildComputerArchive = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  directory = buildComputerArchiveDirectory(environment, platform),
): string =>
  appendCallerPath(
    directory,
    `rea-${PRODUCT_IDENTITY.packageVersion}.tar.xz`,
    platform,
  );

/** The agentenv-framework version `agent-env --version` reports, as `agent-env <version>`. */
export const agentEnvReportedVersion = (stdout: string): string | undefined =>
  /^agent-env (\S+)\s*$/u.exec(stdout.trim())?.[1];

/** An absolute program on PATH, never one a relative PATH entry found. */
export const programOnPath = async (
  program: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string | undefined> => {
  const found = await resolveProgram(program, environment, process.cwd());
  return found === undefined || found.fromRelativeEntry
    ? undefined
    : found.path;
};

/** Resolve a recorded command using the same empty-value fallback as runtime. */
export const resolveBuildComputerProgram = (
  value: string | undefined,
  program: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string | undefined> =>
  value === undefined || value === ""
    ? programOnPath(program, environment)
    : Promise.resolve(value);

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );

/** Where unset build settings are looked for; a test points both at its own folders. */
export interface BuildComputerDefaults {
  /** The folder holding the archive packed for this REA version. */
  readonly archiveDirectory?: string;
  /** The PATH searched for `agent-env` and `docker`. */
  readonly searchPath?: string;
}

/**
 * Fill each unset build setting with its default: `agent-env` and `docker`
 * on PATH, and the archive packed for this REA version when it exists.
 */
export const resolveBuildComputerEnvironment = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  sources: BuildComputerDefaults = {},
): Promise<Readonly<NodeJS.ProcessEnv>> => {
  const defaults: Record<string, string> = {};
  const unset = (name: BuildComputerSetting) =>
    environment[name] === undefined || environment[name] === "";
  const search = { PATH: sources.searchPath ?? environment.PATH };
  const agentEnv = unset("REA_AGENT_ENV_COMMAND")
    ? await resolveBuildComputerProgram(
        environment.REA_AGENT_ENV_COMMAND,
        "agent-env",
        search,
      )
    : undefined;
  if (agentEnv !== undefined) defaults.REA_AGENT_ENV_COMMAND = agentEnv;
  const docker = unset("REA_DOCKER_COMMAND")
    ? await resolveBuildComputerProgram(
        environment.REA_DOCKER_COMMAND,
        "docker",
        search,
      )
    : undefined;
  if (docker !== undefined) defaults.REA_DOCKER_COMMAND = docker;
  const archive = defaultBuildComputerArchive(
    environment,
    platform,
    sources.archiveDirectory,
  );
  if (
    unset("REA_BUILD_COMPUTER_REA_ARCHIVE") &&
    isAbsolute(archive) &&
    (await isFile(archive))
  )
    defaults.REA_BUILD_COMPUTER_REA_ARCHIVE = archive;
  return Object.keys(defaults).length === 0
    ? environment
    : { ...environment, ...defaults };
};
