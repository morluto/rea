import { expect, it } from "vitest";
import { GoBinaryService } from "./GoBinaryService.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { GoBinary } from "../../domain/go/goBinary.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";

const identity = {
  id: "fixture-go",
  name: "Source-owned Go reader seam",
  version: "1",
};
const report: GoBinary = {
  artifact: { path: "/artifacts/program", sha256: "a".repeat(64), bytes: 1024 },
  format: "elf",
  architecture: "riscv64",
  bits: 64,
  byte_order: "little",
  build_info: null,
  limitations: ["Build information unavailable."],
};

it("rejects invalid paths and extra caller arguments before invoking the reader", async () => {
  let calls = 0;
  const service = new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  for (const input of [
    { path: "relative" },
    { path: "/artifacts/\0program" },
    { path: report.artifact.path, execute: true },
  ]) {
    const result = await service.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls).toBe(0);
});

it("requires a complete Evidence retention path before starting summary inspection", async () => {
  let calls = 0;
  const service = new GoBinaryService({
    close: async () => {},
    identity,
    inspect: async () => {
      calls++;
      return ok(report);
    },
  });
  const result = await service.inspect({
    path: report.artifact.path,
    detail: "summary",
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(calls).toBe(0);
});

it("preserves unsupported subject architectures and does not duplicate metadata", async () => {
  const service = new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => Promise.resolve(ok(report)),
  });
  const result = await service.inspect({ path: report.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.subject).toMatchObject({
    architecture: null,
    local_path: report.artifact.path,
    digest: { sha256: report.artifact.sha256 },
  });
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.raw_result).toBeNull();
});

it("preserves byte-valued build metadata and validates compiler source lengths", async () => {
  const moduleBytes = Buffer.concat([
    Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex"),
    Buffer.from([0xff, 10]),
    Buffer.from("f932433186182072008242104116d8f2", "hex"),
  ]);
  const buildInfo: NonNullable<GoBinary["build_info"]> = {
    header_offset: 64,
    encoding: "inline",
    go_version: null,
    go_version_bytes_base64: "/w==",
    module_text: null,
    module_bytes_base64: moduleBytes.toString("base64"),
    version_location: { offset: 128, bytes: 1 },
    module_location: { offset: 256, bytes: moduleBytes.length },
    module: {
      path: null,
      main: null,
      dependencies: [],
      settings: [],
      unparsed_lines: [],
      unparsed_line_bytes_base64: ["/w=="],
      complete: false,
    },
  };
  const partial: GoBinary = {
    ...report,
    build_info: buildInfo,
    limitations: ["Some embedded strings contain non-UTF-8 bytes."],
  };
  const result = await new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => Promise.resolve(ok(partial)),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(partial);

  const mismatched: GoBinary = {
    ...partial,
    build_info: {
      ...buildInfo,
      version_location: { offset: 128, bytes: 2 },
    },
  };
  const invalid = await new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => Promise.resolve(ok(mismatched)),
  }).inspect({ path: report.artifact.path });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error).toBeInstanceOf(AnalysisOutputError);
});

it("refuses reader identity changes and invalid original source ranges", async () => {
  const outside: GoBinary = {
    ...report,
    build_info: {
      header_offset: 1000,
      encoding: "inline",
      go_version: "go1.26.0",
      go_version_bytes_base64: Buffer.from("go1.26.0").toString("base64"),
      module_text: "",
      module_bytes_base64: "",
      version_location: { offset: 2000, bytes: 8 },
      module_location: { offset: 0, bytes: 0 },
      module: {
        path: null,
        main: null,
        dependencies: [],
        settings: [],
        unparsed_lines: [],
        unparsed_line_bytes_base64: [],
        complete: true,
      },
    },
  };
  for (const value of [
    { ...report, artifact: { ...report.artifact, path: "/artifacts/other" } },
    outside,
  ]) {
    const result = await new GoBinaryService({
      close: async () => {},
      identity,
      inspect: () => Promise.resolve(ok(value)),
    }).inspect({ path: report.artifact.path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
});

it("honors cancellation before reading and after a completed observation", async () => {
  const controller = new AbortController();
  const reason = { request: "late Go cancellation" };
  let calls = 0;
  const service = new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const completed = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(completed.ok).toBe(false);
  if (!completed.ok) {
    expect(completed.error).toBeInstanceOf(AnalysisCancelledError);
    expect(completed.error.cause).toBe(reason);
    expect(parseEvidence(completed.error.partialObservation)).toMatchObject({
      operation: "inspect_go_binary",
      normalized_result: report,
    });
  }
  const before = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(before.ok).toBe(false);
  if (!before.ok) expect(before.error).toBeInstanceOf(AnalysisCancelledError);
  expect(calls).toBe(1);
});

it("keeps malformed provider output ahead of a late cancellation", async () => {
  const controller = new AbortController();
  const malformed = {
    ...report,
    artifact: { ...report.artifact, path: "/other" },
  };
  const result = await new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(malformed));
    },
  }).inspect({ path: report.artifact.path }, { signal: controller.signal });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it.each([
  null,
  "caller cancellation",
  { request: "opaque caller value" },
  new Error("caller failure"),
  new AnalysisOutputError("caller_operation", "caller-owned cleanup", {
    cleanup: {
      reason: "unresolved caller resource",
      resources: ["caller resource"],
    },
  }),
])(
  "preserves an opaque admission cancellation reason without invoking the reader: %j",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    let calls = 0;
    const service = new GoBinaryService({
      close: async () => {},
      identity,
      inspect: async () => {
        calls += 1;
        throw new Error("cancelled admission must not invoke the reader");
      },
    });
    const result = await service.inspect(null, { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected cancelled admission");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.partialObservation).toBeUndefined();
    expect(calls).toBe(0);
    if (reason instanceof AnalysisOutputError)
      expect(reason.cleanupIncomplete).toBe(true);
  },
);

it("validates string_literals input options and output invariants", async () => {
  let calls = 0;
  const service = new GoBinaryService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  for (const invalidInput of [
    { path: report.artifact.path, max_string_literals: 10 },
    {
      path: report.artifact.path,
      include_string_literals: false,
      max_string_literals: 10,
    },
    {
      path: report.artifact.path,
      include_string_literals: true,
      max_string_literals: 0,
    },
    {
      path: report.artifact.path,
      include_string_literals: true,
      max_string_literals: 10_001,
    },
  ]) {
    const refused = await service.inspect(invalidInput);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls).toBe(0);

  const baseLiterals: NonNullable<GoBinary["string_literals"]> = {
    evidence_kind: "inferred",
    discovered_count: 2,
    aggregate_bytes: 10,
    max_items: 100,
    truncated: false,
    items: [
      {
        value: "alpha",
        location: { offset: 64, bytes: 5 },
        first_header_offset: 256,
        reference_count: 1,
      },
      {
        value: "bravo",
        location: { offset: 69, bytes: 5 },
        first_header_offset: 272,
        reference_count: 2,
      },
    ],
  };

  for (const malformedStrings of [
    { ...baseLiterals, aggregate_bytes: 9 },
    { ...baseLiterals, discovered_count: 3, truncated: false },
    {
      ...baseLiterals,
      items: [baseLiterals.items[1]!, baseLiterals.items[0]!],
    },
    {
      ...baseLiterals,
      items: [
        { ...baseLiterals.items[0]!, first_header_offset: 1020 },
        baseLiterals.items[1]!,
      ],
    },
  ]) {
    const out = await new GoBinaryService({
      close: async () => {},
      identity,
      inspect: () =>
        Promise.resolve(ok({ ...report, string_literals: malformedStrings })),
    }).inspect({
      path: report.artifact.path,
      include_string_literals: true,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBeInstanceOf(AnalysisOutputError);
  }
});
