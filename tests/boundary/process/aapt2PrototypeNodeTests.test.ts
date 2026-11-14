import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runOwnedCommand } from "../../../src/process/OwnedCommand.js";
import { runningTestDeadline } from "../../support/runningTestDeadline.js";

// These suites use Node's runner and import the actual unshipped prototype.
// Their Vitest owner supplies built artifacts, discovery and CI execution.
it.each([
  "tests/support/command-scope.node.mjs",
  "tests/support/aapt2/prototype.node.mjs",
])(
  "runs prototype boundary regressions: %s",
  { tags: ["long-running"] },
  async (file) => {
    const result = await runOwnedCommand(
      {
        command: process.execPath,
        arguments: ["--test", file],
        cwd: process.cwd(),
        hostEnvironment: process.env,
        runId: `rea-aapt2-node-tests-${randomUUID()}`,
      },
      {
        timeoutMs: runningTestDeadline() ?? null,
        diagnosticBytes: 128 * 1024,
        acceptNonZeroExit: true,
      },
    );
    expect(result.exitCode, result.stdout.text + result.stderr.text).toBe(0);
  },
);
