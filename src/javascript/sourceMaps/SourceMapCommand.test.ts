import { assertProcessOwnershipInspectionActive } from "../../process/ProcessInspectionCancellation.js";
import { ProcessAdmissionError } from "../../process/ProcessAdmissionError.js";
import { access } from "node:fs/promises";
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
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import { WEB_SOURCE_MAP_LIMITS } from "../../domain/sourceMapLimits.js";
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

const runChild = (
  signal: AbortSignal | undefined,
  script: string,
  onRuntime?: (path: string) => void,
) =>
  runSourceMapCommand(
    "{}",
    "/probe/source.map",
    signal === undefined ? undefined : { signal },
    {
      prepareOwnership: async () => {},
      createRuntime: async () => {
        const runtime = await PrivateRuntimeRoot.create({
          prefix: "rea-source-map-command-test-",
        });
        onRuntime?.(runtime.path);
        return runtime;
      },
      launcher: async (options) => {
        const child = await spawnOwnedProviderProcess({
          ...options,
          arguments: ["-e", script],
        });
        return child;
      },
    },
    unexpectedCleanup,
  );

const lateDiagnostic =
  'setTimeout(() => process.stderr.write("late descendant diagnostic"), 400)';
const exitsAfterHoldingOutput = `
  const { spawn } = require("node:child_process");
  spawn(process.execPath, ["-e", ${JSON.stringify(lateDiagnostic)}], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  process.stderr.write("physical exit 7");
  process.exit(7);
`;

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

const exitsThenDescendantExceedsStderrBudget =
  'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",`setTimeout(()=>{process.stderr.write("x".repeat(1024*1024+64)); setInterval(()=>{},1000)},25)`],{stdio:["ignore","inherit","inherit"]}); process.stderr.write("physical exit 7"); process.exit(7)';

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
  const controller = new AbortController();
  let runtimePath: string | undefined;
  let observedBeforeAbort:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  const originalWait = ProviderProcessSupervisor.prototype.waitForOutputClose;
  const waitSpy = vi
    .spyOn(ProviderProcessSupervisor.prototype, "waitForOutputClose")
    .mockImplementation(async function (
      this: ProviderProcessSupervisor,
      timeoutMs,
      signal,
    ) {
      const exit = this.observedExit();
      if (exit?.code === 7 && !controller.signal.aborted) {
        observedBeforeAbort = exit;
        controller.abort(reason);
        return false;
      }
      return originalWait.call(this, timeoutMs, signal);
    });
  let result;
  try {
    result = await runChild(
      controller.signal,
      exitsAfterHoldingOutput,
      (path) => {
        runtimePath = path;
      },
    );
  } finally {
    waitSpy.mockRestore();
  }
  expect(observedBeforeAbort).toEqual({ code: 7, signal: null });
  if (result.ok) throw new Error("expected physical failure");
  expect(result.error._tag).toBe("ProviderAdapterError");
  expect(result.error.diagnostics).toMatchObject({
    exit_code: 7,
    output_complete: false,
  });
  expect(result.error.capturedOutput?.truncated).toBe(true);
  expect(
    result.error.secondaryFailures.find(
      (failure) => failure instanceof AnalysisCancelledError,
    )?.cause,
  ).toBe(reason);
  if (runtimePath === undefined) throw new Error("runtime was not acquired");
  await expect(access(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("classifies the same nonzero exit without cancellation", async () => {
  const result = await runChild(undefined, exitsAfterHoldingOutput);
  if (result.ok) throw new Error("expected physical failure");
  expect(result.error).toMatchObject({
    _tag: "ProviderAdapterError",
    diagnostics: {
      exit_code: 7,
      stderr: "physical exit 7late descendant diagnostic",
      output_complete: true,
    },
  });
});

it("stops a held drain after late output exceeds budget but keeps the exit primary", async () => {
  const startedAt = performance.now();
  const result = await runChild(
    undefined,
    exitsThenDescendantExceedsStderrBudget,
  );
  const elapsedMs = performance.now() - startedAt;
  if (result.ok) throw new Error("expected physical failure");
  expect(result.error._tag).toBe("ProviderAdapterError");
  expect(result.error.diagnostics).toMatchObject({
    exit_code: 7,
    output_limit_reached: true,
    output_complete: false,
  });
  expect(result.error.diagnostics?.stderr).toContain("physical exit 7");
  expect(result.error.capturedOutput?.truncated).toBe(true);
  // The descendant holds stderr open forever, and a drain the codec deadline
  // ends reports the same exit. Only the output-limit stop beats that deadline.
  expect(elapsedMs).toBeLessThan(WEB_SOURCE_MAP_LIMITS.decodeTimeoutMs);
});

it("preserves an observed process-memory limit over the codec exit status", async () => {
  const controller = new AbortController();
  const reason = { caller: "after memory-limit exit" };
  let observedBeforeAbort:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  const originalWait = ProviderProcessSupervisor.prototype.waitForOutputClose;
  const waitSpy = vi
    .spyOn(ProviderProcessSupervisor.prototype, "waitForOutputClose")
    .mockImplementation(async function (
      this: ProviderProcessSupervisor,
      timeoutMs,
      signal,
    ) {
      const exit = this.observedExit();
      if (exit?.code === 3 && !controller.signal.aborted) {
        observedBeforeAbort = exit;
        controller.abort(reason);
        return false;
      }
      return originalWait.call(this, timeoutMs, signal);
    });
  let result;
  try {
    result = await runSourceMapCommand(
      "{}",
      "/probe/source.map",
      { signal: controller.signal },
      {
        prepareOwnership: async () => {},
        launcher: async (options) => {
          const spawned = await spawnOwnedProviderProcess({
            ...options,
            arguments: [
              "-e",
              'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setTimeout(()=>{},400)"],{stdio:["ignore","inherit","inherit"]}); process.stderr.write("memory limit reached"); process.exit(3)',
            ],
          });
          let exited = false;
          spawned.process.once("exit", () => {
            exited = true;
          });
          Object.defineProperty(spawned.process, "memoryLimitReached", {
            get: () => exited,
          });
          return spawned;
        },
      },
      unexpectedCleanup,
    );
  } finally {
    waitSpy.mockRestore();
  }
  expect(observedBeforeAbort).toEqual({ code: 3, signal: null });
  if (result.ok) throw new Error("expected memory-limit failure");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error).toMatchObject({
    resource: "memory",
    reportedLimits: {
      codec_process_memory_limit_bytes: expectedProcessMemoryLimitBytes,
    },
    capturedOutput: { stderr: "memory limit reached" },
  });
  expect(result.error.capturedOutput?.truncated).toBe(true);
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
