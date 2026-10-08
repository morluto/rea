import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import {
  HopperCancelledError,
  HopperProcessError,
  HopperStartError,
} from "../domain/hopperErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import {
  type ProviderProcessLaunch,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { waitForAbortableDelay } from "../process/ProviderDeadline.js";
import {
  selectLinuxPrivateDisplayStrategy,
  type LinuxPrivateDisplayRunnableStrategy,
  type LinuxPrivateDisplaySelection,
} from "./LinuxPrivateDisplayProbe.js";
import writeFileAtomic from "write-file-atomic";

import {
  prepareHopperMachOImage,
  type HopperMachOImage,
} from "./HopperMachOImage.js";

import { acquireHopperTargetLease } from "./HopperTargetLease.js";
import type { HopperTargetLease } from "./HopperTargetLease.js";

const execFileAsync = promisify(execFile);
const HOPPER_BACKGROUND_STARTUP_MS = 5_000;

/** Coordinates for one private bridge session. */
export interface BridgeSession {
  readonly directory: string;
  readonly socketPath: string;
  readonly token: string;
  readonly runId: string;
}

/** Process handle returned by a bridge launcher. */
export type BridgeLaunch =
  | (ProviderProcessLaunch & {
      readonly shutdownMode: "bridge-request";
      readonly preparedImagePath?: string;
      /** The owned helper may hand off to an external GUI application. */
      readonly providerLifetime: "launcher-process" | "external-application";
    })
  | (Extract<ProviderProcessLaunch, { readonly ownsProcessLifetime: true }> & {
      readonly shutdownMode: "process-cleanup";
      readonly preparedImagePath?: string;
      readonly providerLifetime: "launcher-process";
      readonly cleanup: NonNullable<ProviderProcessLaunch["cleanup"]>;
    });

/** Application-owned capability that starts the in-Hopper bridge. */
export interface BridgeLauncher {
  launch(
    session: BridgeSession,
    options?: { readonly signal?: AbortSignal },
  ): Promise<
    Result<
      BridgeLaunch,
      HopperStartError | HopperCancelledError | HopperProcessError
    >
  >;
}

interface SharedHopperApplicationLauncherOptions {
  readonly launcherPath: string;
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
  readonly bridgeScriptPath: string;
  readonly preparedImage?: {
    readonly image: HopperMachOImage;
    readonly sourceSha256: string;
  };
}

/** Explicit launcher contract; the Linux adapter verifies its pinned Hopper build before execution. */
export type HopperApplicationLauncherOptions =
  | (SharedHopperApplicationLauncherOptions & {
      readonly launchMode: "native";
      readonly demoHelperPath?: never;
    })
  | (SharedHopperApplicationLauncherOptions & {
      readonly launchMode: "verified_linux_demo";
      readonly demoHelperPath: string;
    });

export interface HopperApplicationLauncherDependencies {
  readonly platform?: NodeJS.Platform;
  readonly acquireTargetLease?: typeof acquireHopperTargetLease;
  readonly selectPrivateDisplay?: (options: {
    readonly helperPath: string;
    readonly signal?: AbortSignal;
  }) => Promise<LinuxPrivateDisplaySelection>;
}

/**
 * Launches Hopper through its documented CLI and injects only REA's owned bridge.
 *
 * Hopper's `hopper` helper internally issues an AppleScript `activate` command.
 * Consequently, opening a target may bring Hopper to the foreground even though
 * REA first asks macOS to start the application hidden and in the background.
 * REA cannot reliably suppress that activation without replacing Hopper's
 * supported launcher; callers must treat possible foreground UI as an upstream
 * Hopper constraint, not as evidence that analysis failed.
 *
 * REA owns only the short-lived launcher helper's run-token-authenticated
 * process group. It does not claim ownership of the Hopper GUI process that
 * macOS LaunchServices may create or reuse.
 */
export class HopperApplicationLauncher implements BridgeLauncher {
  constructor(
    readonly options: HopperApplicationLauncherOptions,
    readonly dependencies: HopperApplicationLauncherDependencies = {},
  ) {}

  async launch(
    session: BridgeSession,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    Result<
      BridgeLaunch,
      HopperStartError | HopperCancelledError | HopperProcessError
    >
  > {
    const leaseResult = await this.#acquireTargetLease(session.runId);
    if (!leaseResult.ok) return leaseResult;
    const lease = leaseResult.value;
    let leaseTransferred = false;
    try {
      let loadedPath = this.options.targetPath;
      if (this.options.preparedImage !== undefined) {
        const prepared = await prepareHopperMachOImage(
          this.options.targetPath,
          this.options.preparedImage.sourceSha256,
          this.options.preparedImage.image,
          join(session.directory, "image.macho"),
          options.signal,
        );
        if (!prepared.ok) return prepared;
        loadedPath = prepared.value;
      }
      const ownsProcessLifetime = usesLinuxDemo(this.options);
      const bootstrap = await this.#writeBootstrap(
        session,
        ownsProcessLifetime,
        loadedPath,
      );
      if (!bootstrap.ok) return bootstrap;
      const launched = await this.#launchPreparedTarget({
        session,
        signal: options.signal,
        bootstrapPath: bootstrap.value,
        loadedPath,
        ownsProcessLifetime,
        lease,
      });
      leaseTransferred = launched.ok;
      return launched;
    } finally {
      if (!leaseTransferred) await lease?.release();
    }
  }

  async #launchPreparedTarget(input: {
    readonly session: BridgeSession;
    readonly signal: AbortSignal | undefined;
    readonly bootstrapPath: string;
    readonly loadedPath: string;
    readonly ownsProcessLifetime: boolean;
    readonly lease: HopperTargetLease | undefined;
  }): Promise<
    Result<
      BridgeLaunch,
      HopperStartError | HopperCancelledError | HopperProcessError
    >
  > {
    const { session, signal, bootstrapPath, ownsProcessLifetime, lease } =
      input;
    const action =
      this.options.targetKind === "database" ? "--database" : "--executable";
    const argumentsForTarget = [
      ...this.options.loaderArgs,
      "--analysis",
      "-Y",
      bootstrapPath,
      action,
      input.loadedPath,
    ];
    try {
      if (signal?.aborted === true) return err(new HopperCancelledError());
      const display = await this.#privateDisplay(signal);
      if (!display.ok) return err(display.error);
      const prepared = await prepareHopperApplication(
        this.options.launcherPath,
        signal,
      );
      if (!prepared) return err(new HopperCancelledError());
      const linuxDemo = linuxDemoLaunch(
        this.options,
        session,
        argumentsForTarget,
        display.strategy,
      );
      const started = await launchHopperProcess({
        options: this.options,
        session,
        bootstrapPath,
        ownsProcessLifetime,
        argumentsForTarget,
        linuxDemo,
        signal,
      });
      if (started === null) return err(new HopperCancelledError());
      const cleanup = () =>
        cleanupOwnedProcessGroup(started.ownership).finally(() =>
          lease?.release(),
        );
      const ownership = {
        run_id: session.runId,
        pid: started.ownership.leaderPid,
        process_group_id: started.ownership.leaderPid,
        parent_pid: process.pid,
        launcher: linuxDemo?.command ?? this.options.launcherPath,
        created_at: new Date().toISOString(),
      };
      try {
        await writeFileAtomic(
          join(session.directory, "ownership.json"),
          `${JSON.stringify(ownership)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (cause: unknown) {
        await cleanupOwnedProcessGroup(started.ownership);
        return err(new HopperStartError({ cause }));
      }
      const ownedLauncher = {
        ...(this.options.preparedImage === undefined
          ? {}
          : { preparedImagePath: input.loadedPath }),
        process: started.process,
        ownsProcessLifetime: true as const,
        ownership: started.ownership,
        cleanup,
      };
      return ownsProcessLifetime
        ? ok({
            ...ownedLauncher,
            providerLifetime: "launcher-process",
            shutdownMode: "process-cleanup",
          })
        : ok({
            ...ownedLauncher,
            providerLifetime: "external-application",
            shutdownMode: "bridge-request",
          });
    } catch (cause: unknown) {
      return err(hopperLaunchFailure(cause, signal));
    }
  }

  async #acquireTargetLease(
    runId: string,
  ): Promise<Result<HopperTargetLease | undefined, HopperStartError>> {
    if ((this.dependencies.platform ?? process.platform) !== "darwin")
      return ok(undefined);
    try {
      const acquisition = await (
        this.dependencies.acquireTargetLease ?? acquireHopperTargetLease
      )({
        targetPath: this.options.targetPath,
        targetKind: this.options.targetKind,
        loaderArgs: this.options.loaderArgs,
        runId,
      });
      if (!acquisition.acquired)
        return err(
          new HopperStartError({
            ownerRunId: acquisition.owner.runId,
            userMessage:
              `This Hopper target is already open in REA session ${acquisition.owner.runId}. ` +
              "Use that REA session or close it before opening this target again.",
          }),
        );
      return ok(acquisition.lease);
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
  }

  async #writeBootstrap(
    session: BridgeSession,
    ownsProcessLifetime: boolean,
    loadedPath: string,
  ): Promise<Result<string, HopperStartError>> {
    const bootstrapPath = `${session.directory}/bootstrap.py`;
    try {
      await writeFile(
        bootstrapPath,
        bridgeBootstrapSource(
          session,
          this.options,
          ownsProcessLifetime,
          loadedPath,
        ),
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(bootstrapPath, 0o600);
      return ok(bootstrapPath);
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
  }

  async #privateDisplay(signal: AbortSignal | undefined): Promise<
    | {
        readonly ok: true;
        readonly strategy: LinuxPrivateDisplayRunnableStrategy | undefined;
      }
    | {
        readonly ok: false;
        readonly error: HopperProcessError | HopperCancelledError;
      }
  > {
    if (!usesLinuxDemo(this.options)) return { ok: true, strategy: undefined };
    const selection = await (
      this.dependencies.selectPrivateDisplay ??
      selectLinuxPrivateDisplayStrategy
    )({
      helperPath: this.options.demoHelperPath,
      ...(signal === undefined ? {} : { signal }),
    });
    if (signal?.aborted === true)
      return { ok: false, error: new HopperCancelledError() };
    return selection.ok
      ? { ok: true, strategy: selection.strategy }
      : {
          ok: false,
          error: new HopperProcessError(
            selection.exitCode,
            selection.diagnostic,
          ),
        };
  }
}

const bridgeBootstrapSource = (
  session: BridgeSession,
  options: SharedHopperApplicationLauncherOptions,
  ownsProcessLifetime: boolean,
  loadedPath: string,
): string =>
  [
    `REA_SOCKET = ${JSON.stringify(session.socketPath)}`,
    `REA_TOKEN = ${JSON.stringify(session.token)}`,
    `REA_RUN_ID = ${JSON.stringify(session.runId)}`,
    `REA_TARGET_PATH = ${JSON.stringify(loadedPath)}`,
    `REA_OWNS_PROCESS_LIFETIME = ${ownsProcessLifetime ? "True" : "False"}`,
    `exec(compile(open(${JSON.stringify(options.bridgeScriptPath)}, 'rb').read(), ${JSON.stringify(options.bridgeScriptPath)}, 'exec'))`,
    "",
  ].join("\n");

const launchHopperProcess = async (input: {
  readonly options: HopperApplicationLauncherOptions;
  readonly session: BridgeSession;
  readonly bootstrapPath: string;
  readonly ownsProcessLifetime: boolean;
  readonly argumentsForTarget: readonly string[];
  readonly linuxDemo: ReturnType<typeof linuxDemoLaunch>;
  readonly signal: AbortSignal | undefined;
}): Promise<Awaited<ReturnType<typeof spawnOwnedProviderProcess>> | null> => {
  const ownershipCommand =
    input.linuxDemo?.ownershipCommand ?? input.options.launcherPath;
  const spawn = (arguments_: readonly string[]) =>
    spawnOwnedProviderProcess({
      command: input.options.launcherPath,
      arguments: arguments_,
      runId: input.session.runId,
      expectedCommand: ownershipCommand,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  if (input.linuxDemo !== undefined)
    return spawnOwnedProviderProcess({
      command: input.linuxDemo.command,
      arguments: input.linuxDemo.args,
      runId: input.session.runId,
      expectedCommand: ownershipCommand,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  return spawn(input.argumentsForTarget);
};

export const linuxDemoLaunch = (
  options: HopperApplicationLauncherOptions,
  session: BridgeSession,
  hopperArgs: readonly string[],
  strategy: LinuxPrivateDisplayRunnableStrategy | undefined,
):
  | {
      readonly command: string;
      readonly args: readonly string[];
      readonly ownershipCommand: string;
    }
  | undefined => {
  if (!usesLinuxDemo(options) || options.demoHelperPath === undefined)
    return undefined;
  const helperArguments = [
    options.demoHelperPath,
    "--strategy",
    strategy ?? "direct",
    ...(strategy === "user-mount-namespace" ? ["--mount-private-x11"] : []),
    "--hopper",
    options.launcherPath,
    "--socket",
    session.socketPath,
    "--",
    options.launcherPath,
    ...hopperArgs,
  ];
  if (strategy === "user-mount-namespace")
    return {
      command: "/usr/bin/unshare",
      ownershipCommand: "/usr/bin/python3",
      args: [
        "--user",
        "--map-root-user",
        "--mount",
        "--propagation",
        "private",
        "/usr/bin/python3",
        ...helperArguments,
      ],
    };
  return {
    command: "/usr/bin/python3",
    ownershipCommand: "/usr/bin/python3",
    args: helperArguments,
  };
};

const hopperLaunchFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): HopperCancelledError | HopperStartError =>
  signal?.aborted === true
    ? new HopperCancelledError()
    : new HopperStartError({ cause });

/** Select the version-pinned adapter from the caller's explicit launch mode. */
export const usesLinuxDemo = (
  options: HopperApplicationLauncherOptions,
): options is HopperApplicationLauncherOptions & {
  readonly launchMode: "verified_linux_demo";
  readonly demoHelperPath: string;
} => options.launchMode === "verified_linux_demo";

const prepareHopperApplication = async (
  launcherPath: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  const appBundle = hopperApplicationBundle(launcherPath);
  if (appBundle === undefined) return signal?.aborted !== true;
  const executablePath = join(appBundle, "Contents/MacOS/Hopper Disassembler");
  if (await processIsRunning(executablePath)) return signal?.aborted !== true;
  // This reduces activation when Hopper is cold, but the vendor launcher that
  // follows may still activate its window. See HopperApplicationLauncher.
  await execFileAsync("/usr/bin/open", [
    "--hide",
    "--background",
    "-a",
    appBundle,
  ]);
  return (
    (await waitForAbortableDelay(HOPPER_BACKGROUND_STARTUP_MS, signal)) ===
    "elapsed"
  );
};

const hopperApplicationBundle = (launcherPath: string): string | undefined => {
  if (basename(launcherPath) !== "hopper") return undefined;
  const candidate = dirname(dirname(dirname(launcherPath)));
  return extname(candidate) === ".app" ? candidate : undefined;
};

const processIsRunning = async (executablePath: string): Promise<boolean> => {
  try {
    const processes = await execFileOutput("/bin/ps", [
      "-ax",
      "-o",
      "command=",
    ]);
    return processes.stdout
      .split("\n")
      .some((command) => command.trim() === executablePath);
  } catch (cause: unknown) {
    // best-effort cleanup: optional process probing; failure means not running.
    void cause;
    return false;
  }
};
