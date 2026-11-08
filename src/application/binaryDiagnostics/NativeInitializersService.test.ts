import { expect, it } from "vitest";
import { NativeInitializersService } from "./NativeInitializersService.js";
import { NATIVE_INITIALIZERS_PROVIDER } from "../../domain/investigationProviders.js";
import type { NativeInitializers } from "../../domain/native/nativeInitializers.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const identity = NATIVE_INITIALIZERS_PROVIDER;
const report: NativeInitializers = {
  artifact: { path: "/artifacts/app", sha256: "a".repeat(64), bytes: 4096 },
  format: "elf",
  status: "parsed",
  applicability: "applicable",
  architecture: "x86_64",
  bits: 64,
  byte_order: "little",
  machine: 62,
  elf_type: 3,
  slice: null,
  coverage: {
    status: "complete",
    examined_entries: 1,
    total_entries: 1,
    returned_entries: 1,
    offset: 0,
    limit: 64,
  },
  entries: [
    {
      index: 0,
      kind: "init_array",
      slot_va: "0x200",
      slot_file_offset: 512,
      slot_bytes: 8,
      value_va: "0x100",
      value_file_offset: 256,
      slot_section: { name: ".init_array", trust: "observed-untrusted" },
      section: { name: ".text", trust: "observed-untrusted" },
      symbol: { name: "ctor", trust: "observed-untrusted" },
      resolution: "relative_addend",
      detail: "DT_INIT_ARRAY",
    },
  ],
  limitations: ["fixture limitation"],
};

const serviceFor = (value: NativeInitializers) =>
  new NativeInitializersService({
    identity,
    inspect: () => Promise.resolve(ok(value)),
  });

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new NativeInitializersService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  for (const input of [
    { path: "app" },
    { path: report.artifact.path, extra: true },
  ]) {
    const result = await service.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls).toBe(0);
});

it("records the selected image and each slot range as Evidence", async () => {
  const result = await serviceFor(report).inspect({
    path: report.artifact.path,
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "elf", architecture: "x86_64" },
    normalized_result: report,
    locations: [
      { kind: "artifact-path", path: report.artifact.path },
      { kind: "file-offset-range", start: 512, end: 520 },
    ],
  });
});

it.each([
  ["a page that does not match the request", { offset: 1 }],
  ["a returned count that differs from the entries", { returned_entries: 0 }],
  ["complete coverage on an incomplete report", { status: "incomplete" }],
] as const)("rejects provider output with %s", async (_label, coverage) => {
  const result = await serviceFor({
    ...report,
    coverage: { ...report.coverage, ...coverage },
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a slot offset outside the artifact", async () => {
  const [entry] = report.entries;
  const result = await serviceFor({
    ...report,
    entries: [{ ...entry!, slot_file_offset: 4092 }],
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("discards an observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const service = new NativeInitializersService({
    identity,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});
