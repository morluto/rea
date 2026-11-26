import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisTargetFailureError,
} from "../../../src/domain/analysisErrorCore.js";
import { runPcapCommand } from "../../../src/pcap/PcapCommand.js";
import { runOwnedCommand } from "../../../src/process/OwnedCommand.js";
import { prepareProcessOwnershipInspection } from "../../../src/process/ProcessOwnershipObservation.js";
import { providerOutcomeOf } from "../../../src/process/ProviderOutcome.js";

const node = (script: string) => ({
  command: process.execPath,
  arguments: ["-e", script],
  runId: `rea-provider-outcome-test-${randomUUID()}`,
});

const outcomeOf = async (
  spawn: ReturnType<typeof node>,
  limits: { readonly timeoutMs: number; readonly diagnosticBytes: number },
  signal?: AbortSignal,
) => {
  const failure = await runOwnedCommand(
    spawn,
    limits,
    signal === undefined ? {} : { signal },
  ).then(
    () => {
      throw new Error("The command was expected to fail");
    },
    (cause: unknown) => cause,
  );
  return providerOutcomeOf(failure);
};

beforeAll(() => prepareProcessOwnershipInspection());

it("reads a nonzero exit with its retained output and the owner's stop state", async () => {
  const outcome = await outcomeOf(
    node('process.stderr.write("refused"); process.exitCode = 3'),
    { timeoutMs: 10_000, diagnosticBytes: 1024 },
  );
  expect(outcome).toMatchObject({
    kind: "exited",
    exitCode: 3,
    signal: null,
    stopRequested: false,
    output: { truncated: false, snapshot: { stderr: { text: "refused" } } },
  });
});

it("reads the owner's deadline, not the stop it sent, as the outcome", async () => {
  const outcome = await outcomeOf(node("setInterval(() => {}, 1000)"), {
    timeoutMs: 100,
    diagnosticBytes: 1024,
  });
  expect(outcome).toMatchObject({ kind: "timeout" });
});

it("reads an exceeded complete-output budget as truncated output", async () => {
  const outcome = await outcomeOf(
    node('process.stderr.write("x".repeat(4096)); setInterval(() => {}, 1000)'),
    { timeoutMs: 10_000, diagnosticBytes: 64 },
  );
  expect(outcome).toMatchObject({ kind: "output-limit" });
});

it("keeps the caller's opaque cancellation reason", async () => {
  const controller = new AbortController();
  const reason = { request: "caller cancel" };
  const running = outcomeOf(
    node("setInterval(() => {}, 1000)"),
    { timeoutMs: 10_000, diagnosticBytes: 1024 },
    controller.signal,
  );
  setTimeout(() => controller.abort(reason), 50);
  const outcome = await running;
  expect(outcome?.kind).toBe("cancelled");
  expect(outcome?.kind === "cancelled" ? outcome.reason : undefined).toBe(
    reason,
  );
});

it("reads a refused launch with the operating system's code", async () => {
  const outcome = await outcomeOf(
    {
      ...node(""),
      command: `/nonexistent-${randomUUID()}/tool`,
      arguments: [],
    },
    { timeoutMs: 10_000, diagnosticBytes: 1024 },
  );
  expect(outcome).toMatchObject({
    kind: "launch-failed",
    failure: { kind: "missing", code: "ENOENT" },
    output: undefined,
  });
});

it.skipIf(process.platform === "win32")(
  "reads a real oversized argument list as an argument-list launch failure",
  async () => {
    // One 4 MiB argument exceeds the POSIX launch limit (ARG_MAX on macOS,
    // MAX_ARG_STRLEN on Linux), so the operating system refuses the exec.
    const outcome = await outcomeOf(
      { ...node(""), arguments: ["-e", "", "x".repeat(4 * 1024 * 1024)] },
      { timeoutMs: 10_000, diagnosticBytes: 1024 },
    );
    expect(outcome).toMatchObject({
      kind: "launch-failed",
      failure: {
        kind: "argument-list",
        code: "E2BIG",
        executable: process.execPath,
        syscall: `spawn ${process.execPath}`,
      },
      output: undefined,
    });
  },
);

it("is undefined for a failure that is not an owned command outcome", () => {
  expect(providerOutcomeOf(new Error("parse failure"))).toBeUndefined();
});

it("does not read a file errno as a launch failure", async () => {
  const read = await readFile(`/nonexistent-${randomUUID()}/carrier`).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(read).toMatchObject({ code: "ENOENT" });
  expect(providerOutcomeOf(read)).toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "reads an inherited resource-limit signal separately from an ordinary exit",
  async () => {
    const outcome = await outcomeOf(
      node('process.kill(process.pid, "SIGXCPU")'),
      { timeoutMs: 10_000, diagnosticBytes: 1024 },
    );
    expect(outcome).toMatchObject({
      kind: "resource-signal",
      signal: "SIGXCPU",
    });
  },
);

const readCapture = (
  script: string,
  limits = { timeoutMs: 10_000, maxOutputBytes: 1024 },
) =>
  runPcapCommand({
    operation: "inspect_pcap_capture",
    platform: HOST_PLATFORM.platform,
    command: process.execPath,
    arguments: ["-e", script],
    inputPath: "/authored-capture.pcap",
    limits,
    environment: {},
    signal: undefined,
    retain: () => {
      throw new Error("No cleanup is retained");
    },
  }).catch((cause: unknown) => cause);

it("classifies each owner-observed outcome once for a provider command", async () => {
  const timeout = await readCapture("setInterval(() => {}, 1000)", {
    timeoutMs: 100,
    maxOutputBytes: 1024,
  });
  expect(timeout).toBeInstanceOf(AnalysisTimeoutError);
  expect(timeout).toMatchObject({ timeoutMs: 100 });

  const overflow = await readCapture(
    'process.stderr.write("x".repeat(4096)); setInterval(() => {}, 1000)',
    { timeoutMs: 10_000, maxOutputBytes: 64 },
  );
  expect(overflow).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(overflow).toMatchObject({
    reportedLimits: { max_output_bytes: 64 },
    fixedAllowance: { kind: "capture" },
  });
});

it("leaves an exit's meaning to the provider dialect", async () => {
  const failure = await readCapture(
    'process.stderr.write("The file is not a capture file"); process.exitCode = 2',
  );
  expect(failure).toBeInstanceOf(AnalysisTargetFailureError);
  expect(failure).toMatchObject({
    capturedOutput: { stderr: expect.stringContaining("not a capture file") },
  });
});

it("classifies a caller cancellation through the shared owner", async () => {
  const controller = new AbortController();
  const reason = { request: "caller cancel" };
  const running = runPcapCommand({
    operation: "inspect_pcap_capture",
    platform: HOST_PLATFORM.platform,
    command: process.execPath,
    arguments: ["-e", "setInterval(() => {}, 1000)"],
    inputPath: "/authored-capture.pcap",
    limits: { timeoutMs: 10_000, maxOutputBytes: 1024 },
    environment: {},
    signal: controller.signal,
    retain: () => {
      throw new Error("No cleanup is retained");
    },
  }).catch((cause: unknown) => cause);
  setTimeout(() => controller.abort(reason), 50);
  const failure = await running;
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  expect((failure as AnalysisCancelledError).cause).toBe(reason);
});

it("observes a JVM out-of-memory report past the retained output budget", async () => {
  const report =
    'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space';
  const script = `process.stderr.write("x".repeat(4096) + "\\n" + ${JSON.stringify(report)} + "\\n"); process.exitCode = 1`;
  const failure = await runOwnedCommand(node(script), {
    timeoutMs: 10_000,
    diagnosticBytes: 64,
    runtime: "jvm",
  }).catch((cause: unknown) => cause);
  expect(providerOutcomeOf(failure)).toMatchObject({
    kind: "runtime-exhausted",
    exhaustion: { runtime: "jvm", area: "heap", stream: "stderr" },
  });
  // Without the runtime opt-in the same output is only an overflow.
  const unscanned = await runOwnedCommand(node(script), {
    timeoutMs: 10_000,
    diagnosticBytes: 64,
  }).catch((cause: unknown) => cause);
  expect(providerOutcomeOf(unscanned)).toMatchObject({ kind: "output-limit" });
});

it("keeps the omission of a long out-of-memory line on its report", async () => {
  const report = `${"x".repeat(2048)} java.lang.OutOfMemoryError: Java heap space`;
  const script = `process.stderr.write(${JSON.stringify(report)} + "\\n"); process.exitCode = 1`;
  const failure = await runOwnedCommand(node(script), {
    timeoutMs: 10_000,
    diagnosticBytes: 64,
    runtime: "jvm",
  }).catch((cause: unknown) => cause);
  const outcome = providerOutcomeOf(failure);
  expect(outcome).toMatchObject({
    kind: "runtime-exhausted",
    exhaustion: { area: "heap", truncated: true, invalidUtf8: false },
  });
  if (outcome?.kind !== "runtime-exhausted") throw failure;
  expect(outcome.exhaustion.line.length).toBeLessThan(report.length);
});

it("observes a real V8 heap exhaustion report", async () => {
  const failure = await runOwnedCommand(
    {
      ...node(""),
      arguments: [
        "--max-old-space-size=16",
        "-e",
        "const a = []; for (;;) a.push({ value: a.length });",
      ],
    },
    { timeoutMs: 60_000, diagnosticBytes: 64 * 1024, runtime: "v8" },
  ).catch((cause: unknown) => cause);
  expect(providerOutcomeOf(failure)).toMatchObject({
    kind: "runtime-exhausted",
    exhaustion: { runtime: "v8", area: "heap" },
  });
});
