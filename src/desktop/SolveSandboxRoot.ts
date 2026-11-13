import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";

const CLEANUP = fileURLToPath(
  new URL("../../bridge/agentenv/solve_cleanup.py", import.meta.url),
);
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

type RootStop =
  | { status: "verified-cleanup" }
  | { status: "incomplete"; reason: string };

/** Owns a single solve's agentenv sandbox root and any cleanup process. */
export class SolveSandboxRoot {
  #cleanup: ProviderProcessSupervisor | undefined;
  #removed = false;
  #stopping: Promise<RootStop> | undefined;
  private constructor(
    readonly path: string,
    private readonly interpreter: string,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
  ) {}

  static async create(
    interpreter: string,
    environment: Readonly<NodeJS.ProcessEnv>,
  ): Promise<SolveSandboxRoot> {
    const parent =
      environment.AGENT_ENV_LOCAL_SANDBOX_DIR ??
      join(environment.HOME ?? homedir(), ".agent-env-sandboxes");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    return new SolveSandboxRoot(
      await mkdtemp(join(parent, "rea-solve-")),
      interpreter,
      environment,
    );
  }

  get removed(): boolean {
    return this.#removed;
  }

  stop(): Promise<RootStop> {
    if (this.#stopping !== undefined) return this.#stopping;
    const running = this.#stop();
    this.#stopping = running;
    void running.finally(() => {
      if (this.#stopping === running) this.#stopping = undefined;
    });
    return running;
  }

  async #stop(): Promise<RootStop> {
    if (this.#removed) return { status: "verified-cleanup" };
    try {
      if (this.#cleanup !== undefined) {
        const stopped = await this.#cleanup.stop();
        if (stopped.status === "incomplete") return stopped;
        this.#cleanup = undefined;
      }
      const spawned = await spawnOwnedProviderProcess({
        command: this.interpreter,
        arguments: [CLEANUP],
        runId: randomUUID(),
        expectedCommand: null,
        hostEnvironment: this.environment,
        env: {
          AGENT_ENV_LOCAL_SANDBOX_DIR: this.path,
          PYTHONDONTWRITEBYTECODE: "1",
        },
      });
      const supervisor = new ProviderProcessSupervisor(
        {
          ...spawned,
          ownsProcessLifetime: true,
          cleanup:
            spawned.cleanup ??
            (() => cleanupOwnedProcessGroup(spawned.ownership)),
        },
        {
          maxDiagnosticBytes: { stdout: 16 * 1024, stderr: 16 * 1024 },
          diagnosticRetention: "tail",
        },
      );
      this.#cleanup = supervisor;
      const exited = await supervisor.waitForExit(120_000);
      const stopped = await supervisor.stop();
      if (stopped.status === "incomplete") return stopped;
      this.#cleanup = undefined;
      const snapshot = supervisor.snapshot();
      if (!exited || snapshot.diagnosticTruncated || snapshot.exitCode !== 0)
        return {
          status: "incomplete",
          reason:
            `Sandbox cleanup did not complete: ${snapshot.stderr.text} ${snapshot.stdout.text}`.trim(),
        };
      const result = resultSchema.safeParse(JSON.parse(snapshot.stdout.text));
      if (!result.success || !result.data.ok)
        return {
          status: "incomplete",
          reason:
            result.success && !result.data.ok
              ? result.data.error
              : "Sandbox cleanup returned an invalid result.",
        };
      await rmdir(this.path);
      this.#removed = true;
      return { status: "verified-cleanup" };
    } catch (error: unknown) {
      return {
        status: "incomplete",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  dispose(): void {
    this.#cleanup?.dispose();
  }
}
