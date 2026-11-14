import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DoctorHost } from "../application/Doctor.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { assertSetupActive } from "../application/SetupCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type {
  DesktopBuildSetupFacts,
  DesktopBuildSetupHost,
} from "../application/SetupDesktopBuild.js";
import { DESKTOP_EXPORT_FRAMEWORK_VERSION } from "../domain/desktop/appExport.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  agentEnvReportedVersion,
  buildComputerArchiveDirectory,
  defaultBuildComputerArchive,
  programOnPath,
} from "./BuildComputerEnvironment.js";
import { BUILD_COMPUTER_SETTINGS } from "../domain/desktop/buildComputerSettings.js";
import {
  desktopBuildOwnedCommandReason,
  runDesktopBuildOwnedCommand,
} from "./DesktopBuildOwnedCommand.js";

const PACK_SCRIPT = fileURLToPath(
  new URL("../../scripts/pack-build-computer-runtime.mjs", import.meta.url),
);
const CHECKOUT_LOCKFILE = fileURLToPath(
  new URL("../../package-lock.json", import.meta.url),
);
const PROBE = { timeout: 10_000, maxBuffer: 64 * 1024 } as const;
const PACK = { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 } as const;
const INSTALL = { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 } as const;
const ARCHIVE = "REA_BUILD_COMPUTER_REA_ARCHIVE";

/** What setup's fact readers share: the caller's environment and registration reader. */
interface SetupContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly registrations: DoctorHost["clientRegistrations"];
  probe(
    command: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string }>;
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const failureReason = (cause: unknown): string => {
  const stderr = execFileOutputFailure(cause)?.stderr.trim() ?? "";
  const message = cause instanceof Error ? cause.message : String(cause);
  return stderr === "" ? message : `${message}: ${stderr.slice(-2000)}`;
};

/** Setup's desktop build effects on this host. */
export const systemDesktopBuildSetupHost = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  registrations: DoctorHost["clientRegistrations"],
  resources: ArtifactResourceScope,
): DesktopBuildSetupHost => {
  const run = (
    command: string,
    arguments_: readonly string[],
    limits: typeof PROBE,
    env = environment,
  ) =>
    execFileOutput(command, arguments_, {
      ...limits,
      env,
      stopSignal: "SIGTERM",
    });
  return {
    facts: (clientIds) =>
      readSetupFacts(
        {
          environment,
          platform,
          registrations,
          probe: (command, arguments_) => run(command, arguments_, PROBE),
        },
        clientIds,
      ),
    async packRuntime(archive, signal) {
      const partial = join(dirname(archive), `.rea-${randomUUID()}.tar.xz`);
      let commandFinished = false;
      return resources.run(async () => {
        try {
          assertSetupActive(signal);
          await mkdir(dirname(archive), { recursive: true });
          const workspace = await mkdtemp(join(tmpdir(), "rea-desktop-pack-"));
          await runDesktopBuildOwnedCommand({
            command: process.execPath,
            arguments: [PACK_SCRIPT, partial],
            timeoutMs: PACK.timeout,
            maxOutputBytes: PACK.maxBuffer,
            resources,
            partialPath: partial,
            workspace,
            ...(signal === undefined ? {} : { signal }),
            environment: {
              ...environment,
              TMPDIR: workspace,
              TMP: workspace,
              TEMP: workspace,
              npm_config_loglevel: "error",
              npm_config_progress: "false",
              npm_config_fund: "false",
              npm_config_audit: "false",
            },
          });
          commandFinished = true;
          try {
            await rm(workspace, { recursive: true, force: true });
          } catch (cause: unknown) {
            resources.retain({
              kind: "lease",
              resource: workspace,
              lease: {
                release: () => rm(workspace, { recursive: true, force: true }),
              },
            });
            throw cause;
          }
          assertSetupActive(signal);
          await rename(partial, archive);
          return undefined;
        } catch (cause: unknown) {
          if (commandFinished) {
            try {
              await rm(partial, { force: true });
            } catch (cleanup: unknown) {
              const lease = new AnalysisCleanupLease(
                () => rm(partial, { force: true }),
                [partial],
              );
              resources.retain({ kind: "lease", resource: partial, lease });
              if (cause instanceof AnalysisError) {
                const cleanupFailure = new ProviderCleanupError(
                  "rea-desktop",
                  [partial],
                  { reason: failureReason(cleanup) },
                  { operation: "setup", cause: cleanup },
                );
                cleanupFailure.bindCleanupResourceOwner(lease);
                lease.bindCleanupError(cleanupFailure);
                throw analysisErrorWithCleanupFailure(
                  cause,
                  cleanupFailure,
                  "setup",
                ).bindCleanupDependencies([cause, cleanupFailure]);
              }
              return `${desktopBuildOwnedCommandReason(cause)}; partial archive cleanup failed: ${failureReason(cleanup)}`;
            }
          }
          if (cause instanceof AnalysisError) throw cause;
          return desktopBuildOwnedCommandReason(cause);
        }
      });
    },
    async installAgentenv(uv, signal) {
      return resources.run(async () => {
        try {
          assertSetupActive(signal);
          await runDesktopBuildOwnedCommand({
            command: uv,
            arguments: [
              "tool",
              "install",
              `agentenv-framework==${DESKTOP_EXPORT_FRAMEWORK_VERSION}`,
            ],
            timeoutMs: INSTALL.timeout,
            maxOutputBytes: INSTALL.maxBuffer,
            resources,
            environment,
            ...(signal === undefined ? {} : { signal }),
          });
          return undefined;
        } catch (cause: unknown) {
          if (cause instanceof AnalysisError) throw cause;
          return desktopBuildOwnedCommandReason(cause);
        }
      });
    },
  };
};

const readSetupFacts = async (
  context: SetupContext,
  clientIds: readonly string[],
): Promise<DesktopBuildSetupFacts> => {
  const { environment, platform, probe } = context;
  const archive = defaultBuildComputerArchive(environment, platform);
  const selected = BUILD_COMPUTER_SETTINGS.filter(
    (name) => (environment[name] ?? "") !== "",
  );
  const settings = await absoluteSettings(environment, archive, platform);
  const agentEnv = settings.REA_AGENT_ENV_COMMAND;
  const uv = await programOnPath("uv", environment);
  const uvBin =
    uv === undefined
      ? undefined
      : await probe(uv, ["tool", "dir", "--bin"]).then(
          ({ stdout }) => stdout.trim(),
          () => undefined,
        );
  return {
    settings,
    selected,
    archive,
    archivePacked: await stat(archive).then(
      (entry) => entry.isFile(),
      () => false,
    ),
    ...((await exists(PACK_SCRIPT)) && (await exists(CHECKOUT_LOCKFILE))
      ? {}
      : {
          packBlocker:
            "Packing REA's build-computer runtime needs a REA checkout: run rea setup --desktop-build from one (see docs/installation.md#run-rea-from-a-checkout), or pack an archive yourself and set REA_BUILD_COMPUTER_REA_ARCHIVE.",
        }),
    ...(agentEnv === undefined
      ? {}
      : await probe(agentEnv, ["--version"]).then(
          ({ stdout }) => ({
            agentEnvVersion: agentEnvReportedVersion(stdout),
          }),
          () => ({}),
        )),
    ...(uv === undefined || uvBin === undefined || uvBin === ""
      ? {}
      : { uv: { path: uv, agentEnv: join(uvBin, "agent-env") } }),
    recorded: await recordedSettings(context, clientIds, settings),
  };
};

/** Each build setting as an absolute path: the caller's selection, else its default. */
const absoluteSettings = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  archive: string,
  platform: NodeJS.Platform,
): Promise<Record<string, string>> => {
  const settings: Record<string, string> = {};
  for (const [name, program] of [
    ["REA_AGENT_ENV_COMMAND", "agent-env"],
    ["REA_DOCKER_COMMAND", "docker"],
  ] as const) {
    const value = environment[name] ?? "";
    const path =
      value === ""
        ? await programOnPath(program, environment)
        : isAbsolute(value)
          ? value
          : await programOnPath(value, environment);
    if (path !== undefined) settings[name] = path;
  }
  const selectedArchive = environment[ARCHIVE] ?? "";
  settings[ARCHIVE] =
    selectedArchive === ""
      ? archive
      : absoluteCallerPath(selectedArchive, { platform });
  return settings;
};

/**
 * Per client, the build settings its registration records with a value of its
 * own: an archive REA packed for another version is setup's, not the user's,
 * whether or not it is still on disk.
 */
const recordedSettings = async (
  { environment, platform, registrations }: SetupContext,
  clientIds: readonly string[],
  settings: Readonly<Record<string, string>>,
): Promise<Record<string, readonly string[]>> => {
  if (registrations === undefined || clientIds.length === 0) return {};
  const directory = buildComputerArchiveDirectory(environment, platform);
  const setupArchive = (name: string, value: string) =>
    name === ARCHIVE &&
    value !== settings[ARCHIVE] &&
    dirname(resolve(value)) === directory &&
    /^rea-.+\.tar\.xz$/u.test(basename(value));
  // Every name is compared, so a runner not installed yet still reads as unrecorded.
  const compared = {
    ...Object.fromEntries(BUILD_COMPUTER_SETTINGS.map((name) => [name, ""])),
    ...settings,
  };
  const statuses = await registrations(clientIds, compared, setupArchive);
  const recorded: Record<string, string[]> = {};
  for (const status of statuses) {
    if (!clientIds.includes(status.client) || status.command.length === 0)
      continue;
    const gaps = status.provider_settings;
    const replaced = [...(gaps?.unrecorded ?? []), ...(gaps?.owned ?? [])];
    recorded[status.client] = BUILD_COMPUTER_SETTINGS.filter(
      (name) => !replaced.includes(name),
    );
  }
  return recorded;
};
