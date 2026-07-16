import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import writeFileAtomic from "write-file-atomic";

import { AnalysisCancelledError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  type ProviderProcessLaunch,
  type SpawnedOwnedProviderProcess,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  GHIDRA_ANALYSIS_TIMEOUT_SECONDS,
  GHIDRA_MAX_CPU,
  GHIDRA_MAX_HEAP,
} from "./GhidraDefaults.js";
import { ghidraJavaEnvironment } from "./GhidraInstallation.js";

/** Private paths and identity material for one headless Ghidra import. */
export interface GhidraLaunchSession {
  readonly runtimeRoot: string;
  readonly socketPath: string;
  readonly token: string;
  readonly runId: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly providerVersion: string;
  readonly profileDigest: string;
}

/** Process plus private log coordinates returned by a Ghidra launcher. */
export interface GhidraLaunch extends ProviderProcessLaunch {
  readonly projectRoot: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
}

/** Provider-owned capability that starts one isolated headless analysis. */
export interface GhidraLauncher {
  launch(
    session: GhidraLaunchSession,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>>;
}

/** Local launch failure retained as the cause of a provider-neutral error. */
export class GhidraLaunchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GhidraLaunchError";
  }
}

/** Static coordinates for an extracted Ghidra release and packaged script. */
export interface GhidraHeadlessLauncherOptions {
  readonly analyzeHeadlessPath: string;
  readonly javaHome?: string;
  readonly bridgeScriptPath: string;
}

/** Launch Ghidra without copying scripts into or modifying its installation. */
export class GhidraHeadlessLauncher implements GhidraLauncher {
  constructor(readonly options: GhidraHeadlessLauncherOptions) {}

  async launch(
    session: GhidraLaunchSession,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>> {
    if (isAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const paths = ghidraRuntimePaths(session.runtimeRoot);
    let started: SpawnedOwnedProviderProcess | undefined;
    try {
      await Promise.all(
        [
          paths.projectRoot,
          paths.homeRoot,
          paths.tempRoot,
          paths.cacheRoot,
          paths.configRoot,
          paths.dataRoot,
        ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
      );
      await writeFileAtomic(
        paths.descriptorPath,
        `${JSON.stringify({
          schema_version: 1,
          socket_path: session.socketPath,
          token: session.token,
          run_id: session.runId,
          target_sha256: session.targetSha256,
          provider_version: session.providerVersion,
          profile_digest: session.profileDigest,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      started = await spawnOwnedProviderProcess({
        command: this.options.analyzeHeadlessPath,
        arguments: ghidraHeadlessArguments({
          projectRoot: paths.projectRoot,
          targetPath: session.targetPath,
          bridgeScriptPath: this.options.bridgeScriptPath,
          descriptorPath: paths.descriptorPath,
          ghidraLogPath: paths.ghidraLogPath,
          scriptLogPath: paths.scriptLogPath,
        }),
        runId: session.runId,
        // analyzeHeadless is an interpreter-driven script. Parent identity and
        // the per-process run token remain the cleanup authority.
        expectedCommand: null,
        env: ghidraLaunchEnvironment(paths, this.options.javaHome),
      });
      await writeFileAtomic(
        paths.ownershipPath,
        `${JSON.stringify({
          schema_version: 1,
          run_id: session.runId,
          pid: started.ownership.leaderPid,
          process_group_id: started.ownership.processGroupId,
          parent_pid: process.pid,
          launcher: this.options.analyzeHeadlessPath,
          created_at: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (isAborted(options.signal)) {
        await cleanupOwnedProcessGroup(started.ownership);
        return err(new AnalysisCancelledError("open_binary"));
      }
      const ownership = started.ownership;
      return ok({
        process: started.process,
        ownsProcessLifetime: true,
        cleanup: () => cleanupOwnedProcessGroup(ownership),
        projectRoot: paths.projectRoot,
        ghidraLogPath: paths.ghidraLogPath,
        scriptLogPath: paths.scriptLogPath,
      });
    } catch (cause: unknown) {
      if (started !== undefined)
        await cleanupOwnedProcessGroup(started.ownership).catch(
          () => undefined,
        );
      return isAborted(options.signal)
        ? err(new AnalysisCancelledError("open_binary"))
        : err(
            new GhidraLaunchError("Ghidra headless launch failed", { cause }),
          );
    }
  }
}

/** Paths encoded into one bounded analyzeHeadless invocation. */
export interface GhidraHeadlessArgumentOptions {
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly bridgeScriptPath: string;
  readonly descriptorPath: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
}

/** Build the complete read-only headless invocation in deterministic order. */
export const ghidraHeadlessArguments = (
  options: GhidraHeadlessArgumentOptions,
): readonly string[] => [
  options.projectRoot,
  "rea-project",
  "-import",
  options.targetPath,
  "-readOnly",
  "-deleteProject",
  "-analysisTimeoutPerFile",
  String(GHIDRA_ANALYSIS_TIMEOUT_SECONDS),
  "-max-cpu",
  String(GHIDRA_MAX_CPU),
  "-log",
  options.ghidraLogPath,
  "-scriptlog",
  options.scriptLogPath,
  "-scriptPath",
  dirname(options.bridgeScriptPath),
  "-postScript",
  basename(options.bridgeScriptPath),
  options.descriptorPath,
];

const ghidraRuntimePaths = (runtimeRoot: string) => ({
  projectRoot: join(runtimeRoot, "project"),
  homeRoot: join(runtimeRoot, "home"),
  tempRoot: join(runtimeRoot, "tmp"),
  cacheRoot: join(runtimeRoot, "cache"),
  configRoot: join(runtimeRoot, "config"),
  dataRoot: join(runtimeRoot, "data"),
  descriptorPath: join(runtimeRoot, "session.json"),
  ownershipPath: join(runtimeRoot, "ownership.json"),
  ghidraLogPath: join(runtimeRoot, "ghidra.log"),
  scriptLogPath: join(runtimeRoot, "script.log"),
});

const ghidraLaunchEnvironment = (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  javaHome: string | undefined,
): NodeJS.ProcessEnv => ({
  ...ghidraJavaEnvironment(javaHome),
  HOME: paths.homeRoot,
  TMPDIR: paths.tempRoot,
  XDG_CACHE_HOME: paths.cacheRoot,
  XDG_CONFIG_HOME: paths.configRoot,
  XDG_DATA_HOME: paths.dataRoot,
  GHIDRA_HEADLESS_MAXMEM: GHIDRA_MAX_HEAP,
  GHIDRA_HEADLESS_JAVA_OPTIONS: `-Duser.home=${paths.homeRoot} -Djava.io.tmpdir=${paths.tempRoot}`,
});

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
