import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  completeVerifierRun,
  createVerifierRun,
} from "../scripts/lib/verifier-run.mjs";

const execFileAsync = promisify(execFile);

describe.sequential("verifier run identity", () => {
  it("allocates, propagates, and reuses one process-local identity", async () => {
    const previousRunId = process.env.REA_PROCESS_RUN_ID;
    process.env.REA_PROCESS_RUN_ID = "11111111-1111-4111-8111-111111111111";
    try {
      const first = createVerifierRun();
      const nested = createVerifierRun();

      expect(first).toEqual({
        schema_version: 1,
        run_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        verifier_pid: process.pid,
        parent_pid: process.ppid,
      });
      expect(nested.run_id).toBe(first.run_id);
      expect(first.run_id).not.toBe("11111111-1111-4111-8111-111111111111");
      expect(process.env.REA_PROCESS_RUN_ID).toBe(first.run_id);
      const { stdout } = await execFileAsync(process.execPath, [
        "-e",
        "process.stdout.write(process.env.REA_PROCESS_RUN_ID ?? '')",
      ]);
      expect(stdout).toBe(first.run_id);
      const { stdout: nestedProcessRunId } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import { createVerifierRun } from './scripts/lib/verifier-run.mjs'; process.stdout.write(createVerifierRun().run_id)",
        ],
      );
      expect(nestedProcessRunId).not.toBe(first.run_id);
    } finally {
      restoreRunId(previousRunId);
    }
  });

  it.runIf(process.platform !== "win32")(
    "reports token-verified live descendants",
    async () => {
      const previousRunId = process.env.REA_PROCESS_RUN_ID;
      delete process.env.REA_PROCESS_RUN_ID;
      const run = createVerifierRun();
      const child = spawnReadyChild(process.env);
      try {
        await childReady(child);
        const completed = await completeVerifierRun(run);
        expect(completed.process_lineage).toMatchObject({
          status: "verified",
          schema_version: 1,
          observed_at: expect.stringMatching(/Z$/u),
          launcher_pid: process.pid,
          launcher_parent_pid: process.ppid,
          process_group_id: expect.any(Number),
          descendants: expect.arrayContaining([
            {
              pid: child.pid,
              parent_pid: process.pid,
              process_group_id: expect.any(Number),
            },
          ]),
        });
      } finally {
        await stopChild(child);
        restoreRunId(previousRunId);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports unavailable when a live descendant lacks the run token",
    async () => {
      const previousRunId = process.env.REA_PROCESS_RUN_ID;
      delete process.env.REA_PROCESS_RUN_ID;
      const run = createVerifierRun();
      const child = spawnReadyChild({ ...process.env, REA_PROCESS_RUN_ID: "" });
      try {
        await childReady(child);
        const completed = await completeVerifierRun(run);
        expect(completed.process_lineage).toMatchObject({
          status: "unavailable",
          observed_at: expect.stringMatching(/Z$/u),
          launcher_pid: process.pid,
          launcher_parent_pid: process.ppid,
          process_group_id: expect.any(Number),
          reason: `descendant ${String(child.pid)} run token did not match`,
        });
      } finally {
        await stopChild(child);
        restoreRunId(previousRunId);
      }
    },
  );
});

const spawnReadyChild = (env: NodeJS.ProcessEnv): ChildProcess =>
  spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    { env, stdio: ["ignore", "pipe", "ignore"] },
  );

const childReady = async (child: ChildProcess): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", () => resolve());
    child.once("exit", (code) =>
      reject(new Error(`verifier child exited early with ${String(code)}`)),
    );
  });
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  await exited;
};

const restoreRunId = (runId: string | undefined): void => {
  if (runId === undefined) delete process.env.REA_PROCESS_RUN_ID;
  else process.env.REA_PROCESS_RUN_ID = runId;
};
