import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runOwnedCommand } from "../../../src/process/OwnedCommand.js";
import { runningTestDeadline } from "../../support/runningTestDeadline.js";

it.each([
  "experiments/command-scope.node.mjs",
  "experiments/adb-ui/fixture.test.mjs",
  "experiments/adb-ui/lease.test.mjs",
  "experiments/adb-ui/mcp.test.mjs",
])("runs unshipped UI experiment regressions: %s", async (file) => {
  const result = await runOwnedCommand(
    {
      command: process.execPath,
      arguments: ["--test", file],
      cwd: process.cwd(),
      hostEnvironment: process.env,
      runId: `rea-ui-experiment-tests-${randomUUID()}`,
    },
    {
      timeoutMs: runningTestDeadline() ?? null,
      diagnosticBytes: 128 * 1024,
      acceptNonZeroExit: true,
    },
  );
  expect(result.exitCode, result.stdout.text + result.stderr.text).toBe(0);
});
