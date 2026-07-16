import { mkdir } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";

import writeFileAtomic from "write-file-atomic";

import { AnalysisCancelledError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  type ProcessCleanupResult,
} from "../process/ProcessOwnership.js";
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
import type { GhidraTransportKind } from "./GhidraTransport.js";

/** Private paths and identity material for one headless Ghidra import. */
export interface GhidraLaunchSession {
  readonly runtimeRoot: string;
  readonly transport: GhidraTransportKind;
  readonly endpointPath: string;
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
  readonly platform?: NodeJS.Platform;
  readonly comSpec?: string;
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
    const platform = this.options.platform ?? process.platform;
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
          schema_version: 2,
          transport: session.transport,
          endpoint_path: session.endpointPath,
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
      const headlessArguments = ghidraHeadlessArguments({
        projectRoot: paths.projectRoot,
        targetPath: session.targetPath,
        bridgeScriptPath: this.options.bridgeScriptPath,
        descriptorPath: paths.descriptorPath,
        ghidraLogPath: paths.ghidraLogPath,
        scriptLogPath: paths.scriptLogPath,
      });
      const command = ghidraHeadlessCommand({
        platform,
        analyzeHeadlessPath: this.options.analyzeHeadlessPath,
        arguments: headlessArguments,
        ...(this.options.comSpec === undefined
          ? {}
          : { comSpec: this.options.comSpec }),
      });
      started = await spawnOwnedProviderProcess({
        command: command.command,
        arguments: command.arguments,
        runId: session.runId,
        // analyzeHeadless is an interpreter-driven script. Parent identity and
        // the per-process run token remain the cleanup authority.
        expectedCommand: null,
        windowsVerbatimArguments: platform === "win32",
        env: ghidraLaunchEnvironment(paths, this.options.javaHome, platform),
      });
      await writeFileAtomic(
        paths.ownershipPath,
        `${JSON.stringify({
          schema_version: 1,
          run_id: session.runId,
          pid: started.ownership.leaderPid,
          process_group_id: started.ownership.processGroupId,
          parent_pid: process.pid,
          ownership_kind:
            platform === "win32"
              ? "windows-process-tree-p0"
              : "posix-process-group",
          launcher: this.options.analyzeHeadlessPath,
          created_at: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (isAborted(options.signal)) {
        await cleanupStartedProcess(started, platform);
        return err(new AnalysisCancelledError("open_binary"));
      }
      const spawned = started;
      return ok({
        process: spawned.process,
        ownsProcessLifetime: true,
        cleanup: () => cleanupStartedProcess(spawned, platform),
        projectRoot: paths.projectRoot,
        ghidraLogPath: paths.ghidraLogPath,
        scriptLogPath: paths.scriptLogPath,
      });
    } catch (cause: unknown) {
      if (started !== undefined)
        await cleanupStartedProcess(started, platform).catch(() => undefined);
      return isAborted(options.signal)
        ? err(new AnalysisCancelledError("open_binary"))
        : err(
            new GhidraLaunchError("Ghidra headless launch failed", { cause }),
          );
    }
  }
}

/** Exact executable and argv passed to shell-free process creation. */
export interface GhidraHeadlessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

/** Build a direct POSIX launch or a conservatively quoted Windows batch call. */
export const ghidraHeadlessCommand = (options: {
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly arguments: readonly string[];
  readonly comSpec?: string;
}): GhidraHeadlessCommand => {
  if (options.platform !== "win32")
    return {
      command: options.analyzeHeadlessPath,
      arguments: [...options.arguments],
    };
  const comSpec =
    options.comSpec ??
    process.env.ComSpec ??
    (process.env.SystemRoot === undefined
      ? "C:\\Windows\\System32\\cmd.exe"
      : win32.join(process.env.SystemRoot, "System32", "cmd.exe"));
  if (
    !win32.isAbsolute(comSpec) ||
    win32.basename(comSpec).toLowerCase() !== "cmd.exe"
  )
    throw new GhidraLaunchError(
      "Windows ComSpec must be an absolute cmd.exe path",
    );
  const tokens = [options.analyzeHeadlessPath, ...options.arguments].map(
    quoteWindowsBatchToken,
  );
  const invocation = `"${tokens.join(" ")}"`;
  if (invocation.length > 30_000)
    throw new GhidraLaunchError(
      "Windows Ghidra command exceeds the P0 length limit",
    );
  return {
    command: comSpec,
    arguments: ["/d", "/e:on", "/v:off", "/s", "/c", invocation],
  };
};

const quoteWindowsBatchToken = (value: string): string => {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    /["%^!&|<>]/u.test(value)
  )
    throw new GhidraLaunchError(
      "Windows Ghidra P0 paths cannot contain command-interpreter metacharacters",
    );
  return `"${value}"`;
};

const cleanupStartedProcess = (
  started: SpawnedOwnedProviderProcess,
  platform: NodeJS.Platform,
): Promise<ProcessCleanupResult> =>
  platform === "win32"
    ? cleanupWindowsProcessTree(started.ownership.leaderPid)
    : cleanupOwnedProcessGroup(started.ownership);

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
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const javaOptions =
    platform === "win32"
      ? `"-Duser.home=${paths.homeRoot}" "-Djava.io.tmpdir=${paths.tempRoot}"`
      : `-Duser.home=${paths.homeRoot} -Djava.io.tmpdir=${paths.tempRoot}`;
  return {
    ...ghidraJavaEnvironment(javaHome, process.env, platform),
    HOME: paths.homeRoot,
    TMPDIR: paths.tempRoot,
    ...(platform === "win32"
      ? {
          USERPROFILE: paths.homeRoot,
          TEMP: paths.tempRoot,
          TMP: paths.tempRoot,
        }
      : {}),
    XDG_CACHE_HOME: paths.cacheRoot,
    XDG_CONFIG_HOME: paths.configRoot,
    XDG_DATA_HOME: paths.dataRoot,
    GHIDRA_HEADLESS_MAXMEM: GHIDRA_MAX_HEAP,
    GHIDRA_HEADLESS_JAVA_OPTIONS: javaOptions,
  };
};

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
