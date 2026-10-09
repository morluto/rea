import { expect, it } from "vitest";
import { RecordedCrashService } from "./RecordedCrashService.js";
import {
  recordedCrashFixture,
  RECORDED_CRASH_TEST_PROVIDER,
  recordedCrashDebuggerFixture,
} from "../../../tests/fixtures/binaryDiagnostics/recordedCrash.js";
import { parseEvidence } from "../../domain/evidence.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";

it("labels an envelope containing debugger-derived maps as derived", async () => {
  const fixture = recordedCrashFixture();
  fixture.debugger = recordedCrashDebuggerFixture();
  const service = new RecordedCrashService({
    identity: RECORDED_CRASH_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(fixture)),
  });
  const result = await service.inspect({
    path: fixture.artifact.path,
    include_debugger_context: true,
  });
  if (!result.ok) throw result.error;
  const evidence = parseEvidence(result.value);
  expect(evidence.confidence).toBe("derived");
  expect(evidence.normalized_result).toEqual(fixture);
});

it.each([
  { path: "relative.elf" },
  { path: "/selected.core", approval: true },
  { path: 123 },
  {},
])(
  "rejects malformed selection before starting the provider: %j",
  async (input) => {
    const service = new RecordedCrashService({
      identity: RECORDED_CRASH_TEST_PROVIDER,
      inspect: () => {
        throw new Error("must not run");
      },
    });
    expect(await service.inspect(input)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  },
);

it("preserves a provider's actionable unsupported reason", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "fixture-recorded-crash",
    "inspect_recorded_crash",
    "ELF core belongs to recorded-crash analysis.",
  );
  const service = new RecordedCrashService({
    identity: RECORDED_CRASH_TEST_PROVIDER,
    inspect: () => Promise.resolve(err(failure)),
  });
  expect(await service.inspect({ path: "/source.elf" })).toEqual(err(failure));
});

it("cancels before invocation and after an acquired observation", async () => {
  const controller = new AbortController();
  const service = new RecordedCrashService({
    identity: RECORDED_CRASH_TEST_PROVIDER,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(recordedCrashFixture()));
    },
  });
  expect(
    await service.inspect(
      { path: "/artifacts/source-owned.core" },
      { signal: controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      capturedOutput: recordedCrashFixture().diagnostics,
    },
  });
  const untouched = new RecordedCrashService({
    identity: RECORDED_CRASH_TEST_PROVIDER,
    inspect: () => {
      throw new Error("must not run");
    },
  });
  expect(
    await untouched.inspect(
      { path: "/source.elf" },
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});

it.each(["different-path", "invalid-digest", "outside-range"])(
  "rejects provider evidence at the next boundary: %s",
  async (problem) => {
    const fixture = recordedCrashFixture();
    if (problem === "different-path") fixture.artifact.path = "/different.elf";
    if (problem === "invalid-digest") fixture.artifact.sha256 = "unobserved";
    if (problem === "outside-range")
      fixture.segments.push({
        index: 0,
        type: "PT_LOAD",
        offset: "0x200",
        header_location: { offset: "0x0", bytes: "0x38" },
        file_backing: "file",
        file_size: "0x1",
        memory_size: "0x1",
        virtual_address: "0x20000000000001",
        physical_address: "0x0",
        alignment: "0x1",
        flags: "0x5",
      });
    const service = new RecordedCrashService({
      identity: RECORDED_CRASH_TEST_PROVIDER,
      inspect: () => Promise.resolve(ok(fixture)),
    });
    expect(
      await service.inspect({ path: "/artifacts/source-owned.core" }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        capturedOutput: fixture.diagnostics,
      },
    });
  },
);
