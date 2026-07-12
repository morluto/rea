import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import { HopperCancelledError, HopperStartError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cleanupOwnedProcessGroup,
  type ProcessCleanupResult,
} from "../application/ProcessOwnership.js";
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
export interface BridgeLaunch {
  readonly process: ChildProcess;
  readonly ownsProcessLifetime: boolean;
  readonly cleanup?: () => Promise<ProcessCleanupResult>;
}

/** Application-owned capability that starts the in-Hopper bridge. */
export interface BridgeLauncher {
  launch(
    session: BridgeSession,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<BridgeLaunch, HopperStartError | HopperCancelledError>>;
}

export interface HopperApplicationLauncherOptions {
  readonly launcherPath: string;
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
  readonly bridgeScriptPath: string;
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
  constructor(readonly options: HopperApplicationLauncherOptions) {}

  async launch(
    session: BridgeSession,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<BridgeLaunch, HopperStartError | HopperCancelledError>> {
    const bootstrapPath = `${session.directory}/bootstrap.py`;
    const source = [
      `REA_SOCKET = ${JSON.stringify(session.socketPath)}`,
      `REA_TOKEN = ${JSON.stringify(session.token)}`,
      `REA_RUN_ID = ${JSON.stringify(session.runId)}`,
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
      const prepared = await prepareHopperApplication(
        this.options.launcherPath,
        options.signal,
      );
      if (!prepared) return err(new HopperCancelledError());
      const child = spawn(this.options.launcherPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, REA_PROCESS_RUN_ID: session.runId },
      });
      const started = await new Promise<Result<undefined, HopperStartError>>(
        (resolve) => {
          const onSpawn = (): void => {
            child.off("error", onError);
            resolve(ok(undefined));
          };
          const onError = (cause: Error): void => {
            child.off("spawn", onSpawn);
            resolve(err(new HopperStartError({ cause })));
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
        },
      );
      if (!started.ok) return started;
      const pid = child.pid;
      if (pid === undefined)
        return err(
          new HopperStartError({ cause: new Error("missing launcher PID") }),
        );
      const ownership = {
        schema_version: 1,
        run_id: session.runId,
        pid,
        process_group_id: pid,
        parent_pid: process.pid,
        launcher: this.options.launcherPath,
        created_at: new Date().toISOString(),
      };
      try {
        await writeFileAtomic(
          join(session.directory, "ownership.json"),
          `${JSON.stringify(ownership)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (cause: unknown) {
        await cleanupOwnedProcessGroup({
          runId: session.runId,
          leaderPid: pid,
          processGroupId: pid,
        });
        return err(new HopperStartError({ cause }));
      }
      return ok({
        process: child,
        ownsProcessLifetime: true,
        cleanup: () =>
          cleanupOwnedProcessGroup({
            runId: session.runId,
            leaderPid: pid,
            processGroupId: pid,
          }),
      });
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
  }
}

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
  return waitForDelay(HOPPER_BACKGROUND_STARTUP_MS, signal);
};

const waitForDelay = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> => {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
