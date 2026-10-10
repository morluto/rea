import { expect, it } from "vitest";
import { BinaryLayoutService } from "./BinaryLayoutService.js";
import {
  binaryLayoutFixture,
  BINARY_LAYOUT_TEST_PROVIDER,
} from "../../../tests/fixtures/binaryDiagnostics/layout.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { err, ok } from "../../domain/result.js";

it.each([
  { path: "relative.elf" },
  { path: "/selected.elf", approval: true },
  { path: 123 },
  {},
])(
  "rejects malformed selection before starting the provider: %j",
  async (input) => {
    const service = new BinaryLayoutService({
      identity: BINARY_LAYOUT_TEST_PROVIDER,
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

it("records the decoded layout once in its Evidence", async () => {
  const layout = binaryLayoutFixture();
  const service = new BinaryLayoutService({
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => Promise.resolve(ok(layout)),
  });
  const result = await service.inspect({ path: layout.artifact.path });
  if (!result.ok) throw result.error;
  const evidence = parseEvidence(result.value);
  expect(evidence.normalized_result).toEqual(layout);
  expect(evidence.raw_result).toBeNull();
});

it("preserves a provider's actionable unsupported reason", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "fixture-layout",
    "inspect_binary_layout",
    "ELF core belongs to recorded-crash analysis.",
  );
  const service = new BinaryLayoutService({
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => Promise.resolve(err(failure)),
  });
  expect(await service.inspect({ path: "/source.elf" })).toEqual(err(failure));
});

it("cancels before invocation and after an acquired observation", async () => {
  const controller = new AbortController();
  const service = new BinaryLayoutService({
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(binaryLayoutFixture()));
    },
  });
  expect(
    await service.inspect(
      { path: "/artifacts/source-owned.elf" },
      { signal: controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      capturedOutput: binaryLayoutFixture().diagnostics,
    },
  });
  const untouched = new BinaryLayoutService({
    identity: BINARY_LAYOUT_TEST_PROVIDER,
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
    const fixture = binaryLayoutFixture();
    if (problem === "different-path") fixture.artifact.path = "/different.elf";
    if (problem === "invalid-digest") fixture.artifact.sha256 = "unobserved";
    if (problem === "outside-range")
      fixture.segments.push({
        index: 0,
        type: "PT_LOAD",
        offset: "0x80",
        header_location: { offset: "0x0", bytes: "0x38" },
        file_backing: "file",
        file_size: "0x1",
        memory_size: "0x1",
        virtual_address: "0x20000000000001",
        physical_address: "0x0",
        alignment: "0x1",
        flags: "0x5",
        permissions: { read: true, write: false, execute: true },
      });
    const service = new BinaryLayoutService({
      identity: BINARY_LAYOUT_TEST_PROVIDER,
      inspect: () => Promise.resolve(ok(fixture)),
    });
    expect(
      await service.inspect({ path: "/artifacts/source-owned.elf" }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        capturedOutput: fixture.diagnostics,
      },
    });
  },
);
