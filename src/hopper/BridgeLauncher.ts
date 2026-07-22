import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import {
  HopperCancelledError,
  HopperProcessError,
  HopperStartError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
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
export interface BridgeLaunch extends ProviderProcessLaunch {
  /** True when verified process cleanup completes bridge shutdown. */
  readonly shutdownByCleanup?: boolean;
}

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
    const bootstrapPath = `${session.directory}/bootstrap.py`;
    const ownsProcessLifetime = usesLinuxDemo(this.options);
    const source = [
      `REA_SOCKET = ${JSON.stringify(session.socketPath)}`,
      `REA_TOKEN = ${JSON.stringify(session.token)}`,
      `REA_RUN_ID = ${JSON.stringify(session.runId)}`,
      `REA_TARGET_PATH = ${JSON.stringify(this.options.targetPath)}`,
      `REA_OWNS_PROCESS_LIFETIME = ${ownsProcessLifetime ? "True" : "False"}`,
      `exec(compile(open(${JSON.stringify(this.options.bridgeScriptPath)}, 'rb').read(), ${JSON.stringify(this.options.bridgeScriptPath)}, 'exec'))`,
      "",
    ].join("\n");
    try {
      await writeFile(bootstrapPath, source, { encoding: "utf8", mode: 0o600 });
      await chmod(bootstrapPath, 0o600);
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }

    const action =
      this.options.targetKind === "database" ? "--database" : "--executable";
    const args = [
      ...this.options.loaderArgs,
      "--analysis",
      "--python",
      bootstrapPath,
      action,
      this.options.targetPath,
    ];
    try {
      if (options.signal?.aborted === true)
        return err(new HopperCancelledError());
      const display = await this.#privateDisplay(options.signal);
      if (!display.ok) return err(display.error);
      const prepared = await prepareHopperApplication(
        this.options.launcherPath,
        options.signal,
      );
      if (!prepared) return err(new HopperCancelledError());
      const linuxDemo = linuxDemoLaunch(
        this.options,
        session,
        args,
        display.strategy,
      );
      const ownershipCommand =
        linuxDemo?.ownershipCommand ?? this.options.launcherPath;
      const started = await spawnOwnedProviderProcess({
        command: linuxDemo?.command ?? this.options.launcherPath,
        arguments: linuxDemo?.args ?? args,
        runId: session.runId,
        expectedCommand: ownershipCommand,
      });
      const child = started.process;
      const pid = started.ownership.leaderPid;
      const ownership = {
        schema_version: 1,
        run_id: session.runId,
        pid,
        process_group_id: pid,
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
      return ok({
        process: child,
        ownsProcessLifetime: true,
        ownership: started.ownership,
        shutdownByCleanup: ownsProcessLifetime,
        cleanup: () => cleanupOwnedProcessGroup(started.ownership),
      });
    } catch (cause: unknown) {
      return err(hopperLaunchFailure(cause, options.signal));
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
    const processes = await execFileAsync("/bin/ps", ["-ax", "-o", "command="]);
    return processes.stdout
      .split("\n")
      .some((command) => command.trim() === executablePath);
  } catch {
    return false;
  }
};
