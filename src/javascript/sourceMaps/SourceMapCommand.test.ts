import { assertProcessOwnershipInspectionActive } from "../../process/ProcessInspectionCancellation.js";
import { ProcessAdmissionError } from "../../process/ProcessAdmissionError.js";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import * as processOutput from "../../process/ExecFileOutput.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import {
  createSystemProcessOwnershipHost,
  LinuxOwnedProcessPrerequisiteError,
} from "../../process/ProcessOwnershipObservation.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessExitObservation,
} from "../../process/ProviderProcess.js";
import { phaseArrival } from "../../../tests/support/lifecycleHarness.js";
import { WindowsNativeControlUnavailableError } from "../../windows/WindowsOwnedProcess.js";
import type { WebSourceMapReport } from "../../domain/webSourceLocation.js";
import { traceSourceMap } from "./TraceSourceMap.js";
import {
  runSourceMapCommand,
  type SourceMapCleanupRetention,
} from "./SourceMapCommand.js";

const expectedProcessMemoryLimitBytes =
  process.platform === "win32" && process.versions.bun !== undefined
    ? 704 * 1024 * 1024
    : null;

const report = traceSourceMap(
  JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
  "https://app.test/app.map",
  { line: 1, column: 0 },
);
const completedReport: WebSourceMapReport = {
  ...report,
  runtime:
    report.runtime.id === "node-v8"
      ? { ...report.runtime, v8_heap_limit_bytes: 200 * 1024 * 1024 }
      : {
          ...report.runtime,
          process_memory_limit_bytes: expectedProcessMemoryLimitBytes,
        },
};
const completedCodec = `process.stdout.write(${JSON.stringify(JSON.stringify({ state: "success", report: completedReport }))})`;

const unexpectedCleanup: SourceMapCleanupRetention = {};
afterEach(async () => {
  const owner = unexpectedCleanup.owner;
  const failure = await owner?.close();
  if (failure !== undefined) throw failure;
  unexpectedCleanup.owner = undefined;
  expect(owner).toBeUndefined();
});

const runCodecWithHeldStderr = async (
  mode: "diagnostic" | "overflow" | "memory",
  cancelReason?: { caller: string },
) => {
  const controller = new AbortController();
  const observedExit = phaseArrival<{
    exit: ProviderProcessExitObservation;
    runtime: string;
    deadline: AbortSignal | undefined;
  }>();
  const exitCode = mode === "memory" ? 3 : 7;
  const primary =
    mode === "memory" ? "memory limit reached" : "physical exit 7";
  const descendant = `
    const { existsSync } = require("node:fs");
    const gate = setInterval(() => {
      if (!existsSync("release-stderr")) return;
      clearInterval(gate);
      ${
        mode === "overflow"
          ? 'process.stderr.write("x".repeat(1024 * 1024 + 64)); setInterval(() => {}, 1000);'
          : 'process.stderr.write("late descendant diagnostic");'
      }
    }, 10);
  `;
  const codec = `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    process.stderr.write(${JSON.stringify(primary)}, () => process.exit(${String(exitCode)}));
  `;
  const operation = runSourceMapCommand(
    "{}",
    "/probe/source.map",
    { signal: controller.signal },
    {
      prepareOwnership: async () => {},
      launcher: async (options) => {
        const runtime = options.cwd;
        if (runtime === undefined) throw new Error("Expected codec workspace");
        const spawned = await spawnOwnedProviderProcess({
          ...options,
          arguments: ["-e", codec],
        });
        if (mode === "memory")
          Object.defineProperty(spawned.process, "memoryLimitReached", {
            get: () => spawned.process.exitCode !== null,
          });
        spawned.process.once(
          "exit",
          (code: number | null, signal: NodeJS.Signals | null) => {
            observedExit.arrive({
              exit: { code, signal },
              runtime,
              deadline: options.signal,
            });
          },
        );
        return spawned;
      },
    },
    unexpectedCleanup,
  );

  let observed;
  try {
    observed = await observedExit.reached(
      operation,
      "codec exited with stderr held open",
    );
    expect(observed.exit).toEqual({ code: exitCode, signal: null });
    if (cancelReason !== undefined) controller.abort(cancelReason);
    else await writeFile(join(observed.runtime, "release-stderr"), "");
  } catch (cause) {
    controller.abort(cause);
    throw cause;
  } finally {
    // Join even when an assertion or the test-owned pipe release fails.
    await operation;
  }
  const result = await operation;
  if (result.ok) throw new Error("Expected physical failure");
  await expect(access(observed.runtime)).rejects.toMatchObject({
    code: "ENOENT",
  });
  return { error: result.error, deadline: observed.deadline };
};

it("retains a physical process inspection failure when the caller cancels concurrently", async () => {
  const controller = new AbortController();
  const reason = { caller: "cancelled during inspection" };
  const physical = Object.assign(new Error("ps permission denied"), {
    code: "EACCES",
  });
  const command = vi
    .spyOn(processOutput, "execFileOutput")
    .mockImplementation(async () => {
      controller.abort(reason);
      throw physical;
    });
  onTestFinished(() => command.mockRestore());
  const host = createSystemProcessOwnershipHost("linux", {});
  const result = await runSourceMapCommand(
    "{}",
    "/probe/source.map",
    { signal: controller.signal },
    {
      prepareOwnership: () => host.prepare!(),
      launcher: async () => {
        throw new Error("must not launch");
      },
    },
    unexpectedCleanup,
  );
  if (result.ok) throw new Error("expected inspection failure");
  expect(result.error).toBeInstanceOf(LinuxOwnedProcessPrerequisiteError);
  expect(result.error.cause).toBe(physical);
  expect(result.error).toMatchObject({
    remediationAction: expect.stringContaining("EACCES"),
  });
  expect(result.error.secondaryFailures).toHaveLength(1);
  expect(result.error.secondaryFailures[0]).toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: reason,
  });
});

it.each([null, { caller: "late source-map cancellation" }])(
  "retains a late caller reason %j when runtime cleanup first fails",
  async (reason) => {
    const root = await PrivateRuntimeRoot.create({
      prefix: "rea-source-map-late-cleanup-test-",
    });
    const controller = new AbortController();
    let cleanupAttempts = 0;
    const retainedCleanup: SourceMapCleanupRetention = {};
    try {
      const result = await runSourceMapCommand(
        "{}",
        "/probe/source.map",
        { signal: controller.signal },
        {
          prepareOwnership: async () => {},
          createRuntime: async () => ({
            path: root.path,
            close: async () => {
              cleanupAttempts += 1;
              if (cleanupAttempts === 1) {
                controller.abort(reason);
                throw new Error("controlled late cleanup failure");
              }
              await root.close();
            },
          }),
          launcher: async (options) =>
            spawnOwnedProviderProcess({
              ...options,
              arguments: ["-e", completedCodec],
            }),
        },
        retainedCleanup,
      );
      expect(result.ok).toBe(false);
      if (result.ok)
        throw new Error("expected cancellation with cleanup failure");
      expect(result.error.cleanupPrimary).toBeInstanceOf(
        AnalysisCancelledError,
      );
      expect(result.error.cleanupPrimary?.cause).toBe(reason);
      expect(result.error.cleanupResources).toEqual([root.path]);
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(retainedCleanup.owner).toBeDefined();
      await retainedCleanup.owner?.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.cleanupResources).toEqual([]);
      expect(result.error.cleanupPrimary?.cause).toBe(reason);
    } finally {
      await retainedCleanup.owner?.close();
      await root.close();
    }
  },
);

it("preserves an observed nonzero exit before caller cancellation during output drain", async () => {
  const reason = { caller: "later than owned exit" };
  const { error } = await runCodecWithHeldStderr("diagnostic", reason);
  expect(error._tag).toBe("ProviderAdapterError");
  expect(error.diagnostics).toMatchObject({
    exit_code: 7,
    output_complete: false,
  });
  expect(error.capturedOutput?.truncated).toBe(true);
  expect(
    error.secondaryFailures.find(
      (failure) => failure instanceof AnalysisCancelledError,
    )?.cause,
  ).toBe(reason);
});

it("drains inherited stderr after a nonzero codec exit", async () => {
  const { error } = await runCodecWithHeldStderr("diagnostic");
  expect(error).toMatchObject({
    _tag: "ProviderAdapterError",
    diagnostics: {
      exit_code: 7,
      stderr: "physical exit 7late descendant diagnostic",
      output_complete: true,
    },
  });
});

it("stops a held drain after late output exceeds budget but keeps the exit primary", async () => {
  const { error, deadline } = await runCodecWithHeldStderr("overflow");
  expect(error._tag).toBe("ProviderAdapterError");
  expect(error.diagnostics).toMatchObject({
    exit_code: 7,
    output_limit_reached: true,
    output_complete: false,
  });
  expect(error.diagnostics?.stderr).toContain("physical exit 7");
  expect(error.capturedOutput?.truncated).toBe(true);
  // The descendant still holds stderr. Letting the deadline stop the drain
  // would retain the same primary exit, so check that deadline never fired.
  expect(deadline?.aborted).toBe(false);
});

it("preserves an observed process-memory limit over the codec exit status", async () => {
  const { error } = await runCodecWithHeldStderr("memory", {
    caller: "after memory-limit exit",
  });
  expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(error).toMatchObject({
    resource: "memory",
    reportedLimits: {
      codec_process_memory_limit_bytes: expectedProcessMemoryLimitBytes,
    },
    capturedOutput: { stderr: "memory limit reached", truncated: true },
  });
});

it("retains a physical process admission error alongside cancellation", async () => {
  const controller = new AbortController();
  const reason = { caller: "during admission" };
  const physical = new ProcessAdmissionError("reader_closed");
  const result = await runSourceMapCommand(
    "{}",
    "/probe/source.map",
    { signal: controller.signal },
    {
      prepareOwnership: async () => {
        controller.abort(reason);
        throw physical;
      },
    },
    unexpectedCleanup,
  );
  if (result.ok) throw new Error("expected admission failure");
  expect(result.error._tag).toBe("ProviderAdapterError");
  expect(result.error.cause).toBe(physical);
  expect(result.error.secondaryFailures[0]).toBeInstanceOf(
    AnalysisCancelledError,
  );
  expect(result.error.secondaryFailures[0]?.cause).toBe(reason);
});

it.each([
  "distinct reason",
  "shared admission error",
  "observed cancellation",
] as const)(
  "keeps the launcher's reported outcome for %s",
  async (scenario) => {
    const controller = new AbortController();
    const physical = new ProcessAdmissionError("baseline_unavailable");
    const reason =
      scenario === "distinct reason"
        ? { caller: "during codec launch" }
        : physical;
    const result = await runSourceMapCommand(
      "{}",
      "/probe/source.map",
      { signal: controller.signal },
      {
        prepareOwnership: async () => {},
        launcher: async ({ signal }) => {
          controller.abort(reason);
          if (scenario === "observed cancellation")
            assertProcessOwnershipInspectionActive(signal);
          throw physical;
        },
      },
      unexpectedCleanup,
    );
    if (result.ok) throw new Error("expected failed launch");
    if (scenario === "observed cancellation") {
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(result.error.secondaryFailures).toHaveLength(0);
    } else {
      expect(result.error._tag).toBe("ProviderAdapterError");
      expect(result.error.cause).toBe(physical);
      expect(result.error.secondaryFailures).toHaveLength(1);
      const [cancelled] = result.error.secondaryFailures;
      expect(cancelled).toBeInstanceOf(AnalysisCancelledError);
      expect(cancelled?.cause).toBe(reason);
    }
  },
);

it.each([
  [
    "physical OS spawn error",
    Object.assign(new Error("spawn resource unavailable"), { code: "EAGAIN" }),
    "ProviderAdapterError",
  ],
  [
    "Windows memory capability refusal",
    new WindowsNativeControlUnavailableError("job-memory-limit"),
    "AnalysisCapabilityUnavailableError",
  ],
] as const)(
  "keeps a %s alongside caller cancellation",
  async (_name, physical, errorTag) => {
    const controller = new AbortController();
    const reason = { caller: "during process spawn" };
    const result = await runSourceMapCommand(
      "{}",
      "/probe/source.map",
      { signal: controller.signal },
      {
        prepareOwnership: async () => {},
        launcher: async () => {
          controller.abort(reason);
          throw physical;
        },
      },
      unexpectedCleanup,
    );
    if (result.ok) throw new Error("expected launch rejection");
    expect(result.error._tag).toBe(errorTag);
    expect(result.error.cause).toBe(physical);
    expect(result.error.secondaryFailures).toHaveLength(1);
    expect(result.error.secondaryFailures[0]).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(result.error.secondaryFailures[0]?.cause).toBe(reason);
  },
);
