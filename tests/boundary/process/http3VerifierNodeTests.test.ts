import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runOwnedCommand } from "../../../src/process/OwnedCommand.js";

// These verifier tests use Node's test runner and exercise the actual script
// modules. Run them in the built lane because the lifecycle module imports dist.
const runNodeTests = async (file: string): Promise<void> => {
  const result = await runOwnedCommand(
    {
      command: process.execPath,
      arguments: ["--test", file],
      cwd: process.cwd(),
      hostEnvironment: process.env,
      runId: `rea-http3-node-tests-${randomUUID()}`,
    },
    { timeoutMs: 30_000, diagnosticBytes: 64 * 1024, acceptNonZeroExit: true },
  );
  expect(result.exitCode, result.stdout.text + result.stderr.text).toBe(0);
};

it("runs HTTP/3 capture assertion regressions", async () => {
  await runNodeTests("scripts/lib/http3-capture-assertions.test.mjs");
}, 60_000);

it.skipIf(process.platform === "win32")(
  "runs POSIX HTTP/3 lifecycle regressions",
  async () => {
    await runNodeTests("scripts/lib/http3-verifier-lifecycle.test.mjs");
  },
  60_000,
);
