import { expect, it } from "vitest";

import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { bindGhidraSessionFailure } from "./GhidraSessionError.js";
import { GhidraLaunchError } from "./GhidraLauncher.js";

it("reports truncated cyclic causes in serializable diagnostics", () => {
  const cause = new Error("cyclic launcher failure");
  cause.cause = cause;
  const projectFailure = bindGhidraSessionFailure(() => ({}));

  const diagnostics = projectFailure(
    "start",
    "Ghidra launcher failed",
    cause,
  ).diagnostics;

  expect(JSON.stringify(diagnostics)).toContain('"cause_truncated":true');
});

it("keeps bounded compiler and nested launcher outcomes in diagnostics", () => {
  const compiler = new DarwinProcessOwnershipInspectionError(
    "macOS process ownership helper compilation failed via xcrun (compiler result: 7)",
    {
      cause: Object.assign(new Error("compiler exited"), { code: 7 }),
      compilerOutcome: {
        outcome: "exited",
        code: 7,
        signal: null,
        stderr: "SDK mismatch",
        stderrBytes: 12,
        stderrTruncated: false,
        outputTruncated: false,
        killed: false,
      },
    },
  );
  const launch = new GhidraLaunchError("Ghidra headless launch failed", {
    cause: compiler,
  });
  const projectFailure = bindGhidraSessionFailure(() => ({}));

  expect(
    projectFailure("start", "Ghidra launcher failed", launch).diagnostics,
  ).toMatchObject({
    failure_cause: {
      name: "GhidraLaunchError",
      cause: {
        name: "DarwinProcessOwnershipInspectionError",
        compiler_outcome: {
          outcome: "exited",
          code: 7,
          stderr: "SDK mismatch",
        },
        cause: { code: 7 },
      },
    },
  });

  const spawnFailure = Object.assign(
    new Error("spawn analyzeHeadless ENOENT"),
    { code: "ENOENT" },
  );
  const launchFailure = new GhidraLaunchError("Ghidra headless launch failed", {
    cause: spawnFailure,
  });
  expect(
    projectFailure("start", "Ghidra launcher failed", launchFailure)
      .diagnostics,
  ).toMatchObject({
    failure_cause: {
      name: "GhidraLaunchError",
      cause: { code: "ENOENT" },
    },
  });
});

it("bounds compiler stderr after explicit redaction at UTF-8 boundaries", () => {
  const sensitiveValue = "caller-selected-secret";
  const projectFailure = bindGhidraSessionFailure(
    () => ({}),
    (value) => value.replaceAll(sensitiveValue, "replacement".repeat(100)),
  );
  const stderr = `${"é".repeat(3900)}${sensitiveValue}`;
  const compiler = new DarwinProcessOwnershipInspectionError(
    "compiler failed",
    {
      compilerOutcome: {
        outcome: "exited",
        code: 1,
        signal: null,
        stderr,
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        stderrTruncated: false,
        outputTruncated: false,
        killed: false,
      },
    },
  );
  const failureCause = projectFailure(
    "start",
    "Ghidra launcher failed",
    compiler,
  ).diagnostics.failure_cause as {
    readonly compiler_outcome: {
      readonly stderr: string;
      readonly stderrTruncated: boolean;
    };
  };

  expect(
    Buffer.byteLength(failureCause.compiler_outcome.stderr, "utf8"),
  ).toBeLessThanOrEqual(8 * 1024);
  expect(failureCause.compiler_outcome.stderrTruncated).toBe(true);
  expect(failureCause.compiler_outcome.stderr).not.toContain(sensitiveValue);
  expect(failureCause.compiler_outcome.stderr).not.toContain("\uFFFD");
});
