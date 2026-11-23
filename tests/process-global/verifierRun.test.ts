import { once } from "node:events";
import { describe, expect } from "vitest";

import {
  completeVerifierRun,
  createVerifierRun,
} from "../../scripts/lib/verifier-run.mjs";
import { phaseArrival } from "../support/lifecycleHarness.js";
import { processTest } from "../support/process/processFixture.js";

const runModule = new URL("../../scripts/lib/verifier-run.mjs", import.meta.url)
  .href;
const reportId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const restoreRunId = (runId: string | undefined): void => {
  if (runId === undefined) delete process.env.REA_PROCESS_RUN_ID;
  else process.env.REA_PROCESS_RUN_ID = runId;
};

describe("verifier run identity", { concurrent: false }, () => {
  processTest(
    "keeps one report per process and propagates its token",
    async ({ processes }) => {
      const previous = process.env.REA_PROCESS_RUN_ID;
      const foreign = "11111111-1111-4111-8111-111111111111";
      process.env.REA_PROCESS_RUN_ID = foreign;
      try {
        const run = createVerifierRun();
        expect(run).toEqual({
          run_id: expect.stringMatching(reportId),
          verifier_pid: process.pid,
          parent_pid: process.ppid,
        });
        expect(run.run_id).not.toBe(foreign);

        process.env.REA_PROCESS_RUN_ID = foreign;
        expect(createVerifierRun()).toEqual(run);
        const child = await processes.run(process.execPath, [
          "--input-type=module",
          "-e",
          `
import { createVerifierRun } from ${JSON.stringify(runModule)};
const inherited = process.env.REA_PROCESS_RUN_ID;
process.stdout.write(JSON.stringify({ inherited, own: createVerifierRun().run_id }));
`,
        ]);
        expect(child.exitCode, child.stderr).toBe(0);
        const identity = JSON.parse(child.stdout);
        expect(identity).toEqual({
          inherited: run.run_id,
          own: expect.stringMatching(reportId),
        });
        expect(identity.own).not.toBe(run.run_id);
      } finally {
        restoreRunId(previous);
      }
    },
  );

  processTest.skipIf(process.platform === "win32")(
    "keeps a fresh report ID while verifying descendants with an inherited token",
    async ({ processes }) => {
      const inherited = "fixture-parent-process-token";
      const outcome = await processes.run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { completeVerifierRun, createVerifierRun } from ${JSON.stringify(runModule)};
const run = createVerifierRun({ inheritProcessRunId: true });
const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
const closed = once(child, "close");
try {
  await once(child, "spawn");
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
      expect(outcome.exitCode, outcome.stderr).toBe(0);
      const report = JSON.parse(outcome.stdout);
      expect(report.processToken).toBe(inherited);
      expect(report.run.run_id).toMatch(reportId);
      expect(report.run.process_lineage).toMatchObject({
        status: "verified",
        descendants: [expect.objectContaining({ pid: report.child })],
      });
    },
  );

  processTest.skipIf(process.platform === "win32")(
    "requires a matching run token for live descendant lineage",
    async ({ processes }) => {
      const previous = process.env.REA_PROCESS_RUN_ID;
      try {
        const run = createVerifierRun();
        for (const owned of [true, false]) {
          const ready = phaseArrival<string>();
          // Linux must handle a newline in the launcher-reported process name.
          const displayName =
            owned && process.platform === "linux" ? "fixture\nworker" : "";
          const child = processes.spawn(
            process.execPath,
            [
              "-e",
              `if (process.argv[1]) process.title = process.argv[1];
process.stdin.resume(); process.stdout.write("ready");`,
              displayName,
            ],
            {
              env: {
                ...process.env,
                REA_PROCESS_RUN_ID: owned ? run.run_id : "",
              },
            },
          );
          child.stdout.once("data", (chunk: Buffer) => {
            ready.arrive(chunk.toString("utf8"));
          });
          try {
            await expect(
              ready.reached(once(child, "close"), "verifier child readiness"),
            ).resolves.toBe("ready");
            const completed = await completeVerifierRun(run);
            if (owned) {
              expect(completed.process_lineage).toMatchObject({
                status: "verified",
                launcher_pid: process.pid,
                launcher_parent_pid: process.ppid,
                descendants: [
                  {
                    pid: child.pid,
                    parent_pid: process.pid,
                    process_group_id: expect.any(Number),
                  },
                ],
              });
            } else {
              expect(completed.process_lineage).toMatchObject({
                status: "unavailable",
                reason: `descendant ${String(child.pid)} run token did not match`,
              });
            }
          } finally {
            child.stdin.end();
            await processes.shutdown();
          }
        }
      } finally {
        restoreRunId(previous);
      }
    },
  );
});
