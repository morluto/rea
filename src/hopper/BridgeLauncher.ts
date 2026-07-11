import { spawn, type ChildProcess } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";

import { HopperStartError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

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
      `BETTER_BINARY_SOCKET = ${JSON.stringify(session.socketPath)}`,
      `BETTER_BINARY_TOKEN = ${JSON.stringify(session.token)}`,
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
