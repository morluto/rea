import { parseEvidence } from "../../domain/evidence.js";
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
import { readNativeInitializers } from "../../native/initializers/NativeInitializersProvider.js";
import { machoArm64FatInitializers } from "../../native/initializers/NativeInitializers.fixture.js";

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

const selectedArm64Report = async () => {
  const bytes = machoArm64FatInitializers();
  const selected = await readNativeInitializers(
    bytes,
    { ...report.artifact, bytes: bytes.length },
    {
      path: report.artifact.path,
      offset: 0,
      limit: 64,
      architecture: "arm64",
    },
  );
  if (selected.slice === null)
    throw new Error("Expected the authored universal slice");
  return { ...selected, slice: selected.slice };
};

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

it.each(["arm64", "x86_64", undefined] as const)(
  "binds a universal initializer report to the caller's architecture %s",
  async (architecture) => {
    const bytes = machoArm64FatInitializers();
    const parsed = await readNativeInitializers(
      bytes,
      { ...report.artifact, bytes: bytes.length },
      {
        path: report.artifact.path,
        offset: 0,
        limit: 64,
        architecture: "arm64",
      },
    );
    const result = await serviceFor(parsed).inspect({
      path: report.artifact.path,
      ...(architecture === undefined ? {} : { architecture }),
    });
    expect(result.ok).toBe(architecture === "arm64");
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisOutputError);
      return;
    }
    expect(result.value).toMatchObject({
      subject: { format: "mach-o-universal", architecture: "arm64" },
      normalized_result: parsed,
      parameters: { architecture: "arm64" },
    });
  },
);

it("rejects an architecture selection when the report has no universal slice", async () => {
  const result = await serviceFor(report).inspect({
    path: report.artifact.path,
    architecture: "arm64",
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
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

it("retains a completed observation when the caller cancels as the provider completes", async () => {
  const controller = new AbortController();
  const reason = { request: "late native initializer cancellation" };
  const service = new NativeInitializersService({
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "inspect_native_initializers",
    normalized_result: report,
  });
});

it.each([
  { machine: 0x01000007 },
  { architecture: "x86_64" as const },
  { format: "elf" as const },
])(
  "refuses contradictory selected-image facts %j before Evidence",
  async (changes) => {
    const bytes = machoArm64FatInitializers();
    const selected = await readNativeInitializers(
      bytes,
      { ...report.artifact, bytes: bytes.length },
      {
        path: report.artifact.path,
        offset: 0,
        limit: 64,
        architecture: "arm64",
      },
    );
    const result = await serviceFor({ ...selected, ...changes }).inspect({
      path: report.artifact.path,
      architecture: "arm64",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  },
);

it("refuses a slice architecture label that disagrees with the selected image", async () => {
  const selected = await selectedArm64Report();
  const result = await serviceFor({
    ...selected,
    slice: { ...selected.slice, architecture: "x86_64" },
  }).inspect({
    path: report.artifact.path,
    architecture: "arm64",
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it.each([
  { field: "slot_file_offset" as const },
  { field: "value_file_offset" as const },
])(
  "refuses $field that lies in the container but outside the selected slice",
  async ({ field }) => {
    const selected = await selectedArm64Report();
    const [entry] = selected.entries;
    if (entry === undefined)
      throw new Error("Expected an initializer in the selected slice");
    const result = await serviceFor({
      ...selected,
      entries: selected.entries.map((item, index) =>
        index === 0 ? { ...item, [field]: 0 } : item,
      ),
    }).inspect({
      path: report.artifact.path,
      architecture: "arm64",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  },
);

it("keeps an entry offset that starts at the selected slice", async () => {
  const selected = await selectedArm64Report();
  const [entry] = selected.entries;
  if (entry === undefined)
    throw new Error("Expected an initializer in the selected slice");
  const result = await serviceFor({
    ...selected,
    entries: selected.entries.map((item, index) =>
      index === 0
        ? { ...item, value_file_offset: selected.slice.file_offset }
        : item,
    ),
  }).inspect({
    path: report.artifact.path,
    architecture: "arm64",
  });
  if (!result.ok) throw result.error;
  const observed = result.value.normalized_result as NativeInitializers;
  expect(observed.slice).toMatchObject({
    architecture: "arm64",
    file_offset: selected.slice.file_offset,
  });
  expect(observed.entries[0]?.value_file_offset).toBe(
    selected.slice.file_offset,
  );
  expect(observed.entries).toHaveLength(selected.entries.length);
});

it.each([
  { label: "ends at EOF", extraOffset: 0, extraSize: 0, accepted: true },
  {
    label: "starts one byte too late",
    extraOffset: 1,
    extraSize: 0,
    accepted: false,
  },
  {
    label: "extends one byte too far",
    extraOffset: 0,
    extraSize: 1,
    accepted: false,
  },
])(
  "binds the selected slice extent when it $label",
  async ({ extraOffset, extraSize, accepted }) => {
    const bytes = machoArm64FatInitializers();
    const selected = await readNativeInitializers(
      bytes,
      { ...report.artifact, bytes: bytes.length },
      {
        path: report.artifact.path,
        offset: 0,
        limit: 64,
        architecture: "arm64",
      },
    );
    if (selected.slice === null)
      throw new Error("Expected the authored universal slice");
    const value = {
      ...selected,
      slice: {
        ...selected.slice,
        file_offset:
          selected.artifact.bytes - selected.slice.size + extraOffset,
        size: selected.slice.size + extraSize,
      },
    };
    const result = await serviceFor(value).inspect({
      path: report.artifact.path,
      architecture: "arm64",
    });
    expect(result.ok).toBe(accepted);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  },
);
