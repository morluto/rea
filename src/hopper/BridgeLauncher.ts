import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import { HopperStartError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

const execFileAsync = promisify(execFile);
const HOPPER_BACKGROUND_STARTUP_MS = 5_000;

/** Coordinates for one private bridge session. */
export interface BridgeSession {
  readonly directory: string;
  readonly socketPath: string;
  readonly token: string;
}

/** Process handle returned by a bridge launcher. */
export interface BridgeLaunch {
  readonly process: ChildProcess;
  readonly ownsProcessLifetime: boolean;
}

/** Application-owned capability that starts the in-Hopper bridge. */
export interface BridgeLauncher {
  launch(
    session: BridgeSession,
  ): Promise<Result<BridgeLaunch, HopperStartError>>;
}

export interface HopperApplicationLauncherOptions {
  readonly launcherPath: string;
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
  readonly bridgeScriptPath: string;
}

/** Launches Hopper through its documented CLI and injects only the owned bridge script. */
export class HopperApplicationLauncher implements BridgeLauncher {
  constructor(readonly options: HopperApplicationLauncherOptions) {}

  async launch(
    session: BridgeSession,
  ): Promise<Result<BridgeLaunch, HopperStartError>> {
    const bootstrapPath = `${session.directory}/bootstrap.py`;
    const source = [
      `REA_SOCKET = ${JSON.stringify(session.socketPath)}`,
      `REA_TOKEN = ${JSON.stringify(session.token)}`,
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
      await prepareHopperApplication(this.options.launcherPath);
      const child = spawn(this.options.launcherPath, args, {
        stdio: ["ignore", "ignore", "pipe"],
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
      return ok({ process: child, ownsProcessLifetime: false });
    } catch (cause: unknown) {
      return err(new HopperStartError({ cause }));
    }
  }
}

const prepareHopperApplication = async (
  launcherPath: string,
): Promise<void> => {
  const appBundle = hopperApplicationBundle(launcherPath);
  if (appBundle === undefined) return;
  const executablePath = join(appBundle, "Contents/MacOS/Hopper Disassembler");
  if (await processIsRunning(executablePath)) return;
  await execFileAsync("/usr/bin/open", [
    "--hide",
    "--background",
    "-a",
    appBundle,
  ]);
  await new Promise((resolve) =>
    setTimeout(resolve, HOPPER_BACKGROUND_STARTUP_MS),
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
