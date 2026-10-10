import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";

import writeFileAtomic from "write-file-atomic";

import { windowsPrivateRuntime } from "../windows/WindowsPrivateRuntime.js";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
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
import { ghidraJavaEnvironment } from "./GhidraInstallation.js";
import { ghidraJavaLaunch } from "./GhidraJavaLaunch.js";
import type { GhidraTransportKind } from "./GhidraTransport.js";
import {
  snapshotGhidraExtensions,
  type GhidraExtension,
} from "./extensions/GhidraExtensions.js";

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
export type GhidraLaunch = ProviderProcessLaunch & {
  readonly projectRoot: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
};

/** Provider-owned capability that starts one isolated headless analysis. */
export interface GhidraLauncher {
  launch(
    session: GhidraLaunchSession,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>>;
}

/** Local launch failure retained as the cause of a provider-neutral error. */
export class GhidraLaunchError extends Error {
  readonly #partialLaunch: GhidraLaunch | undefined;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly partialLaunch?: GhidraLaunch },
  ) {
    const { partialLaunch, ...errorOptions } = options ?? {};
    super(message, errorOptions);
    this.name = "GhidraLaunchError";
    this.#partialLaunch = partialLaunch;
  }

  /** Process ownership retained for the client to retry an incomplete rollback. */
  get partialLaunch(): GhidraLaunch | undefined {
    return this.#partialLaunch;
  }
}

/** Static coordinates for an extracted Ghidra release and packaged script. */
export interface GhidraHeadlessLauncherOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly analyzeHeadlessPath: string;
  readonly javaHome?: string;
  readonly bridgeScriptPath: string;
  readonly platform?: NodeJS.Platform;
  readonly comSpec?: string;
  /** Select the admitted 16-bit real-mode MZ import instead of auto-detection. */
  readonly dosMz?: true;
  readonly dosCom?: true;
  readonly analysisExtensions?: readonly GhidraExtension[];
  /** Spawn seam for provider-boundary lifecycle tests. */
  readonly spawnProcess?: typeof spawnOwnedProviderProcess;
}

/** Launch Ghidra without copying scripts into or modifying its installation. */
export class GhidraHeadlessLauncher implements GhidraLauncher {
  readonly options: GhidraHeadlessLauncherOptions;
  constructor(options: GhidraHeadlessLauncherOptions) {
    this.options = {
      ...options,
      environment: snapshotEnvironment(options.environment, options.platform),
    };
  }

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
      await createGhidraRuntimeDirectories(paths, platform);
      const extensions = await snapshotGhidraExtensions(
        this.options.analysisExtensions ?? [],
        session.runtimeRoot,
      );
      await writeGhidraRuntimeFile(
        paths.descriptorPath,
        `${JSON.stringify({
          transport: session.transport,
          endpoint_path: session.endpointPath,
          token: session.token,
          run_id: session.runId,
          target_sha256: session.targetSha256,
          provider_version: session.providerVersion,
          profile_digest: session.profileDigest,
          ...(extensions.length === 0
            ? {}
            : { analysis_extensions: extensions }),
        })}\n`,
        platform,
      );
      if (isAborted(options.signal))
        return err(new AnalysisCancelledError("open_binary"));
      const headlessArguments = ghidraHeadlessArguments({
        platform,
        projectRoot: paths.projectRoot,
        targetPath: session.targetPath,
        bridgeScriptPath: this.options.bridgeScriptPath,
        descriptorPath: paths.descriptorPath,
        ghidraLogPath: paths.ghidraLogPath,
        scriptLogPath: paths.scriptLogPath,
        ...(this.options.dosCom === undefined
          ? {}
          : { dosCom: this.options.dosCom }),
        ...(this.options.dosMz === undefined
          ? {}
          : { dosMz: this.options.dosMz }),
      });
      const scriptCommand = ghidraHeadlessCommand({
        environment: this.options.environment,
        platform,
        analyzeHeadlessPath: this.options.analyzeHeadlessPath,
        arguments: headlessArguments,
        ...(this.options.comSpec === undefined
          ? {}
          : { comSpec: this.options.comSpec }),
      });
      const environment = ghidraLaunchEnvironment(
        paths,
        this.options.javaHome,
        platform,
        scriptCommand.command,
        this.options.environment,
      );
      if (platform !== "win32" && this.options.javaHome === undefined)
        throw new GhidraLaunchError(
          "POSIX Ghidra requires its inspected JDK home",
        );
      const command =
        platform !== "win32" && this.options.javaHome !== undefined
          ? await ghidraJavaLaunch({
              platform,
              analyzeHeadlessPath: this.options.analyzeHeadlessPath,
              javaHome: this.options.javaHome,
              homeRoot: paths.homeRoot,
              tempRoot: paths.tempRoot,
              arguments: headlessArguments,
              environment,
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
            })
          : { ...scriptCommand, environment };
      started = await (this.options.spawnProcess ?? spawnOwnedProviderProcess)({
        command: command.command,
        arguments: command.arguments,
        runId: session.runId,
        // POSIX launches the inspected JVM directly; script wrappers cannot
        // preserve JVM property paths containing spaces as single arguments.
        expectedCommand: platform !== "win32" ? command.command : null,
        windowsVerbatimArguments: platform === "win32",
        platform,
        env: command.environment,
        hostEnvironment: {},
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const partialLaunch = ownedGhidraLaunch(started, paths, platform);
      await writeGhidraRuntimeFile(
        paths.ownershipPath,
        `${JSON.stringify({
          run_id: session.runId,
          transport: session.transport,
          endpoint_path: session.endpointPath,
          pid: started.ownership.leaderPid,
          process_group_id: started.ownership.processGroupId,
          parent_pid: process.pid,
          ownership_kind:
            platform === "win32" ? "windows-job-object" : "posix-process-group",
          launcher: command.command,
          headless_script: this.options.analyzeHeadlessPath,
          created_at: new Date().toISOString(),
        })}\n`,
        platform,
      );
      if (isAborted(options.signal)) {
        throw new AnalysisCancelledError("open_binary");
      }
      return ok(partialLaunch);
    } catch (cause: unknown) {
      const primary = isAborted(options.signal)
        ? new AnalysisCancelledError("open_binary", { cause })
        : new GhidraLaunchError("Ghidra headless launch failed", { cause });
      if (started === undefined) return err(primary);

      let cleanupFailure: unknown;
      try {
        const cleanup = await cleanupStartedProcess(started, platform);
        if (!cleanup.cleaned)
          cleanupFailure = new Error(
            `Ghidra process cleanup was incomplete: ${cleanup.reason}`,
          );
      } catch (failure: unknown) {
        cleanupFailure = failure;
      }
      if (cleanupFailure !== undefined) {
        const partialLaunch = ownedGhidraLaunch(started, paths, platform);
        const primaryMessage = isAborted(options.signal)
          ? primary.message
          : `Ghidra headless launch failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        return err(
          new GhidraLaunchError(
            `${primaryMessage}; process cleanup remains incomplete`,
            {
              cause: new AggregateError(
                [primary, cleanupFailure],
                "Ghidra launch rollback did not release its process",
                { cause: primary },
              ),
              partialLaunch,
            },
          ),
        );
      }
      return err(primary);
    }
  }
}

const ownedGhidraLaunch = (
  spawned: SpawnedOwnedProviderProcess,
  paths: ReturnType<typeof ghidraRuntimePaths>,
  platform: NodeJS.Platform,
): GhidraLaunch => ({
  ...ownedGhidraProcess(spawned, platform),
  projectRoot: paths.projectRoot,
  ghidraLogPath: paths.ghidraLogPath,
  scriptLogPath: paths.scriptLogPath,
});

const ownedGhidraProcess = (
  spawned: SpawnedOwnedProviderProcess,
  platform: NodeJS.Platform,
): Pick<
  Extract<ProviderProcessLaunch, { readonly ownsProcessLifetime: true }>,
  "process" | "ownsProcessLifetime" | "ownership" | "cleanup"
> => ({
  process: spawned.process,
  ownsProcessLifetime: true,
  ownership: spawned.ownership,
  cleanup: () => cleanupStartedProcess(spawned, platform),
});

/** Exact executable and argv passed to shell-free process creation. */
export interface GhidraHeadlessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

/** Build a direct POSIX launch or a conservatively quoted Windows batch call. */
export const ghidraHeadlessCommand = (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
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
  const environment = snapshotEnvironment(
    options.environment,
    options.platform,
  );
  const systemRoot = environment.SYSTEMROOT;
  const comSpec =
    options.comSpec ??
    environment.COMSPEC ??
    (systemRoot === undefined
      ? "C:\\Windows\\System32\\cmd.exe"
      : win32.join(systemRoot, "System32", "cmd.exe"));
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
  started.cleanup !== undefined
    ? started.cleanup()
    : platform === "win32"
      ? cleanupWindowsProcessTree(started.ownership.leaderPid)
      : cleanupOwnedProcessGroup(started.ownership);

/** Paths encoded into one bounded analyzeHeadless invocation. */
export interface GhidraHeadlessArgumentOptions {
  readonly platform?: NodeJS.Platform;
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly bridgeScriptPath: string;
  readonly descriptorPath: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
  readonly dosMz?: true;
  readonly dosCom?: true;
}

/** Build the complete read-only headless invocation in deterministic order. */
export const ghidraHeadlessArguments = (
  options: GhidraHeadlessArgumentOptions,
): readonly string[] => {
  // Bridge script paths use the target platform's syntax, which differs from
  // the host when building a cross-platform invocation.
  const scriptPath =
    (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const bridgeDirectory = scriptPath.dirname(options.bridgeScriptPath);
  return [
    options.projectRoot,
    "rea-project",
    "-import",
    options.targetPath,
    ...(options.dosMz === true
      ? [
          "-loader",
          "MzLoader",
          "-processor",
          "x86:LE:16:Real Mode",
          "-cspec",
          "default",
        ]
      : options.dosCom === true
        ? [
            "-loader",
            "BinaryLoader",
            "-loader-baseAddr",
            "1000:0100",
            "-processor",
            "x86:LE:16:Real Mode",
            "-cspec",
            "default",
          ]
        : []),
    "-readOnly",
    "-deleteProject",
    "-log",
    options.ghidraLogPath,
    "-scriptlog",
    options.scriptLogPath,
    "-scriptPath",
    bridgeDirectory,
    ...(options.dosCom === true
      ? [
          "-preScript",
          scriptPath.join(bridgeDirectory, "ReaGhidraPrepareCom.java"),
        ]
      : []),
    ...((options.platform ?? process.platform) === "win32"
      ? []
      : [
          "-postScript",
          scriptPath.join(bridgeDirectory, "ReaGhidraNoReturnFix.java"),
        ]),
    "-postScript",
    // Ghidra checks the caller's cwd before scriptPath for a basename. Select
    // the packaged source explicitly so unrelated entries cannot shadow it.
    options.bridgeScriptPath,
    options.descriptorPath,
  ];
};

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

const createGhidraRuntimeDirectories = async (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  platform: NodeJS.Platform,
): Promise<void> => {
  if (platform === "win32") {
    const runtime = windowsPrivateRuntime(dirname(paths.projectRoot));
    for (const path of [
      paths.projectRoot,
      paths.homeRoot,
      paths.tempRoot,
      paths.cacheRoot,
      paths.configRoot,
      paths.dataRoot,
    ])
      runtime.mkdir(basename(path));
    return;
  }
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
};

const writeGhidraRuntimeFile = async (
  path: string,
  content: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  if (platform === "win32") {
    windowsPrivateRuntime(dirname(path)).writeFile(basename(path), content);
    return;
  }
  await writeFileAtomic(path, content, { encoding: "utf8", mode: 0o600 });
};

const ghidraLaunchEnvironment = (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  javaHome: string | undefined,
  platform: NodeJS.Platform,
  executable: string,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  return {
    ...ghidraJavaEnvironment(javaHome, selectedEnvironment, platform),
    ...ghidraHeadlessJavaOptions(paths.homeRoot, paths.tempRoot, platform),
    HOME: paths.homeRoot,
    TMPDIR: paths.tempRoot,
    ...(platform === "win32"
      ? {
          // Batch FOR /F launches another command interpreter through ComSpec.
          // Use the same executable with the spelling consumed by cmd.exe.
          ComSpec: executable.replaceAll("/", "\\"),
          USERPROFILE: paths.homeRoot,
          APPDATA: paths.configRoot,
          LOCALAPPDATA: paths.cacheRoot,
          TEMP: paths.tempRoot,
          TMP: paths.tempRoot,
        }
      : {}),
    XDG_CACHE_HOME: paths.cacheRoot,
    XDG_CONFIG_HOME: paths.configRoot,
    XDG_DATA_HOME: paths.dataRoot,
  };
};

/** Encode provider-owned JVM paths for the platform launcher that consumes them. */
export const ghidraHeadlessJavaOptions = (
  homeRoot: string,
  tempRoot: string,
  platform: NodeJS.Platform,
): Pick<
  NodeJS.ProcessEnv,
  "JDK_JAVA_OPTIONS" | "GHIDRA_HEADLESS_JAVA_OPTIONS"
> => {
  const options = [`-Duser.home=${homeRoot}`, `-Djava.io.tmpdir=${tempRoot}`];
  if (platform === "win32")
    return {
      JDK_JAVA_OPTIONS: [...options, "-XX:-UsePerfData"]
        .map(quoteWindowsBatchToken)
        .join(" "),
      GHIDRA_HEADLESS_JAVA_OPTIONS: "",
    };
  // POSIX launches the JVM directly, so these properties travel as separate
  // argv items instead of the shell-split analyzeHeadless option list.
  return { JDK_JAVA_OPTIONS: "", GHIDRA_HEADLESS_JAVA_OPTIONS: "" };
};

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
