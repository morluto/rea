import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  completeVerifierRun,
  createVerifierRun,
} from "../../scripts/lib/verifier-run.mjs";
import { waitForExit } from "../support/process/processFixture.js";

const execFileAsync = promisify(execFile);
const CHILD_SHUTDOWN_GRACE_MS = 1_000;

describe("verifier run identity", { concurrent: false }, () => {
  it("allocates, propagates, and reuses one process-local identity", async () => {
    const previousRunId = process.env.REA_PROCESS_RUN_ID;
    process.env.REA_PROCESS_RUN_ID = "11111111-1111-4111-8111-111111111111";
    try {
      const first = createVerifierRun();
      const nested = createVerifierRun();

      expect(first).toEqual({
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
    "keeps a fresh report ID while verifying descendants with an inherited token",
    async () => {
      const inherited = "fixture-parent-process-token";
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { completeVerifierRun, createVerifierRun } from "./scripts/lib/verifier-run.mjs";
const run = createVerifierRun({ inheritProcessRunId: true });
const child = spawn(process.execPath, ["-e",
  "process.stdout.write('ready'); process.stdin.resume()"]);
const closed = once(child, "close");
try {
  await once(child.stdout, "data");
  process.stdout.write(JSON.stringify({
    run: await completeVerifierRun(run),
    child: child.pid,
    processToken: process.env.REA_PROCESS_RUN_ID,
  }));
} finally {
  child.stdin.end();
  await closed;
}
`,
        ],
        { env: { ...process.env, REA_PROCESS_RUN_ID: inherited } },
      );
      const report = JSON.parse(stdout);
      expect(report.processToken).toBe(inherited);
      expect(report.run.run_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(report.run.process_lineage).toMatchObject({
        status: "verified",
        descendants: [expect.objectContaining({ pid: report.child })],
      });
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each([
      undefined,
      ...(process.platform === "linux" ? ["fixture\nworker"] : []),
    ])(
    "reports token-verified live descendants with display name %j",
    async (displayName) => {
      const previousRunId = process.env.REA_PROCESS_RUN_ID;
      delete process.env.REA_PROCESS_RUN_ID;
      const run = createVerifierRun();
      const child = spawnReadyChild(process.env, displayName);
      try {
        await childReady(child);
        const completed = await completeVerifierRun(run);
        expect(completed.process_lineage).toMatchObject({
          status: "verified",
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

const spawnReadyChild = (
  env: NodeJS.ProcessEnv,
  displayName?: string,
): ChildProcess =>
  spawn(
    process.execPath,
    [
      "-e",
      `if (process.argv[1] !== undefined) process.title = process.argv[1]; process.stdout.write("ready"); setInterval(() => {}, 1000)`,
      ...(displayName === undefined ? [] : [displayName]),
    ],
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
  child.kill("SIGTERM");
  if (await waitForExit(child, CHILD_SHUTDOWN_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, CHILD_SHUTDOWN_GRACE_MS))) {
    throw new Error(
      `verifier child ${String(child.pid)} did not exit after SIGKILL`,
    );
  }
};

const restoreRunId = (runId: string | undefined): void => {
  if (runId === undefined) delete process.env.REA_PROCESS_RUN_ID;
  else process.env.REA_PROCESS_RUN_ID = runId;
};
