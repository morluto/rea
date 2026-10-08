import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../../src/domain/analysisErrorBase.js";
import { EvidenceIntegrityError } from "../../../../src/domain/evidenceErrors.js";
import { nativeCallObservationResultSchema } from "../../../../src/domain/native/nativeCallObservation.js";
import { err, ok, type Result } from "../../../../src/domain/result.js";
import type {
  NativeCallTrace,
  NativeCallTracer,
} from "../../../../src/native/LldbCallTracer.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const LOCATION = {
  load_address: "0x100000928",
  file_address: "0x100000928",
  module: "Fixture",
  module_path: "/tmp/Fixture",
  symbol: "-[Greeter greet:times:]",
};

const run = (
  overrides: Partial<NativeCallTrace["run"]> = {},
): NativeCallTrace["run"] => ({
  status: "traced",
  version: "lldb-2100.0.17.203",
  pid: 4242,
  outcome: "exited",
  exit_status: 0,
  exit_description: null,
  killed: false,
  terminated: true,
  elapsed_ms: 12.5,
  breakpoints: [
    { index: 0, location_count: 1, locations: [LOCATION] },
    { index: 1, location_count: 1, locations: [LOCATION] },
  ],
  events: [
    {
      sequence: 0,
      elapsed_ms: 3,
      thread_id: 7,
      breakpoint_index: 0,
      ...LOCATION,
      receiver_class: "Greeter",
      selector: "greet:times:",
      registers: [
        { name: "x0", value: "0x6000" },
        { name: "x1", value: "0x7000" },
      ],
      backtrace: [],
    },
  ],
  other_stops: [],
  ...overrides,
});

/** Records the request and returns a canned run or failure. */
class FixtureTracer implements NativeCallTracer {
  readonly requests: Parameters<NativeCallTracer["trace"]>[0][] = [];

  constructor(
    private readonly outcome: Result<NativeCallTrace, AnalysisError> = ok({
      debugger: {
        path: "/usr/bin/lldb",
        sha256: "a".repeat(64),
        version: "lldb-2100.0.17.203",
      },
      run: run(),
      stdout: { text: "hello\n", bytes: 6, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      terminated: true,
    }),
  ) {}

  trace(request: Parameters<NativeCallTracer["trace"]>[0]) {
    this.requests.push(request);
    return Promise.resolve(this.outcome);
  }
}

const BREAKPOINTS = [
  { kind: "objc-method", class_name: "Greeter", selector: "greet:times:" },
  { kind: "function", name: "rea_add" },
];

const fixtureTarget = async () => {
  const directory = await createTestTempDirectory("rea-native-calls-");
  const path = join(directory, "Fixture");
  await writeFile(path, "fixture executable");
  return {
    ...nativeMachoTarget(path),
    sha256: createHash("sha256").update("fixture executable").digest("hex"),
  };
};

const observe = async (
  tracer: NativeCallTracer,
  parameters: Record<string, unknown>,
  target?: Awaited<ReturnType<typeof fixtureTarget>>,
  signal?: AbortSignal,
) =>
  new NativeMacOSProvider(new NativeFixtureRunner(), "darwin", tracer)
    .createClient(target ?? (await fixtureTarget()))
    .execute(
      "observe_native_calls",
      // The provider parses JSON-like parameters itself.
      JSON.parse(JSON.stringify(parameters)),
      signal === undefined ? undefined : { signal },
    );

describe("observe_native_calls projection", () => {
  it("launches the active Mach-O through the tracer and projects its run", async () => {
    const tracer = new FixtureTracer();
    const target = await fixtureTarget();
    const observed = await observe(
      tracer,
      { breakpoints: BREAKPOINTS, arguments: ["--flag"] },
      target,
    );
    if (!observed.ok) throw observed.error;
    expect(tracer.requests[0]).toMatchObject({
      executable: target.path,
      architecture: "arm64",
      input: {
        arguments: ["--flag"],
        duration_ms: 10_000,
        max_events: 1_000,
        argument_registers: 4,
        backtrace_frames: 0,
      },
    });
    const result = nativeCallObservationResultSchema.parse(
      observed.value.result,
    );
    expect(result.breakpoints.map(({ request }) => request)).toEqual([
      {
        kind: "objc-method",
        class_name: "Greeter",
        selector: "greet:times:",
        method_type: "any",
      },
      { kind: "function", name: "rea_add", module: null },
    ]);
    expect(result.process).toMatchObject({
      pid: 4242,
      outcome: "exited",
      exit_status: 0,
      terminated: true,
      stdout: { text: "hello\n" },
    });
    expect(result.events[0]).toMatchObject({
      receiver_class: "Greeter",
      selector: "greet:times:",
    });
    expect(result.coverage).toEqual({
      status: "complete",
      event_limit_reached: false,
      unresolved_breakpoints: [],
    });
    expect(observed.value.locations).toEqual([
      { kind: "artifact-path", path: target.path },
    ]);
  });

  it("marks event limits, unresolved breakpoints and unconfirmed exits", async () => {
    const tracer = new FixtureTracer(
      ok({
        debugger: {
          path: "/usr/bin/lldb",
          sha256: "a".repeat(64),
          version: null,
        },
        run: run({
          outcome: "event-limit",
          exit_status: null,
          killed: true,
          terminated: false,
          breakpoints: [
            { index: 0, location_count: 1, locations: [LOCATION] },
            { index: 1, location_count: 0, locations: [] },
          ],
        }),
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "x".repeat(16), bytes: 2_000_000, truncated: true },
        terminated: true,
      }),
    );
    const observed = await observe(tracer, {
      breakpoints: BREAKPOINTS,
      max_events: 1,
    });
    if (!observed.ok) throw observed.error;
    const result = nativeCallObservationResultSchema.parse(
      observed.value.result,
    );
    expect(result.coverage).toEqual({
      status: "partial",
      event_limit_reached: true,
      unresolved_breakpoints: [1],
    });
    expect(result.process.terminated).toBe(false);
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        "Observation stopped at max_events (1); later calls were not recorded and the process was killed.",
        "Breakpoints 1 matched no code in any image loaded while observing; their calls could not be observed.",
        "Target output beyond 1 MiB per stream is counted but not kept.",
        "REA could not confirm that process 4242 exited; check for it before relying on host state.",
      ]),
    );
  });
});

describe("observe_native_calls failures", () => {
  it("rejects malformed input before launching anything", async () => {
    for (const parameters of [
      { breakpoints: [] },
      { breakpoints: [{ kind: "objc-method", selector: "-[A b]" }] },
      { breakpoints: BREAKPOINTS, environment: { "A=B": "x" } },
      { breakpoints: BREAKPOINTS, argument_registers: 9 },
    ]) {
      const tracer = new FixtureTracer();
      const observed = await observe(tracer, parameters);
      expect(observed.ok).toBe(false);
      if (!observed.ok)
        expect(observed.error).toBeInstanceOf(AnalysisInputError);
      expect(tracer.requests).toEqual([]);
    }
  });

  it("refuses a changed or non-Mach-O target", async () => {
    const tracer = new FixtureTracer();
    const target = await fixtureTarget();
    const changed = await observe(
      tracer,
      { breakpoints: BREAKPOINTS },
      { ...target, sha256: "f".repeat(64) },
    );
    expect(!changed.ok && changed.error).toBeInstanceOf(EvidenceIntegrityError);
    const database = await new NativeMacOSProvider(
      new NativeFixtureRunner(),
      "darwin",
      tracer,
    )
      .createClient({
        path: target.path,
        sha256: target.sha256,
        kind: "database",
        format: "analysis-database",
      })
      .execute("observe_native_calls", { breakpoints: [] });
    expect(!database.ok && database.error).toBeInstanceOf(
      AnalysisCapabilityUnavailableError,
    );
    expect(tracer.requests).toEqual([]);
  });

  it("keeps the tracer's failure reason and caller cancellation", async () => {
    const denied = new AnalysisCapabilityUnavailableError(
      "native-macos",
      "observe_native_calls",
      "debugger-attach-denied: attach failed",
    );
    const failed = await observe(new FixtureTracer(err(denied)), {
      breakpoints: BREAKPOINTS,
    });
    expect(!failed.ok && failed.error).toBe(denied);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await observe(
      new FixtureTracer(),
      { breakpoints: BREAKPOINTS },
      undefined,
      controller.signal,
    );
    expect(!cancelled.ok && cancelled.error).toBeInstanceOf(
      AnalysisCancelledError,
    );
  });
});
