import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { GoBinaryService } from "../../../src/application/go/GoBinaryService.js";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import { GO_ANALYSIS_BUDGET_DEFAULTS } from "../../../src/domain/go/goBinary.js";
import { NATIVE_STRUCTURE_BYTES } from "../../../src/domain/native/nativeStructureBudget.js";
import {
  AnalysisTargetFailureError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { BinaryFormatFailure } from "../../../src/domain/binaryContainer.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  createGoBinaryFixture,
  createGoInlineAggregateFixture,
  createGoOverlappingElfFixture,
} from "../../fixtures/go/image.js";
import { createGoRodataStringFixture } from "../../fixtures/go/rodataStringImage.js";
import { CPU_ARM64, universalMacho } from "../../fixtures/universalMacho.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads Go build information from a PE32 image declaring one data directory", async () => {
  const root = await createTestTempDirectory("rea-go-pe-directories-");
  const fixture = createGoBinaryFixture({ format: "pe", bits: 32 });
  fixture.bytes.writeUInt32LE(1, 152 + 92);
  const path = join(root, "one-directory-pe32.exe");
  await writeFile(path, fixture.bytes);
  const structureBytes = NATIVE_STRUCTURE_BYTES.default_value * 2;
  const result = await new GoBinaryProvider().inspect({
    path,
    max_structure_bytes: structureBytes,
  });
  if (!result.ok) throw result.error;
  expect(result.value.build_info).toMatchObject({ go_version: "go1.26.0" });
  expect(
    result.value.limitations.some((limitation) =>
      limitation.includes(`max_structure_bytes=${String(structureBytes)}`),
    ),
  ).toBe(true);
  expect(
    result.value.limitations.some((limitation) =>
      limitation.includes(
        `max_structure_bytes=${String(NATIVE_STRUCTURE_BYTES.default_value)}`,
      ),
    ),
  ).toBe(false);
});

it.each([false, true])(
  "reports whether an oversized Mach-O command table is file-backed (%s)",
  async (stored) => {
    const tableBytes = 16 * 1024 * 1024 + 8;
    const bytes = Buffer.alloc(stored ? 40 : 32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x01000007, 4);
    bytes.writeUInt32LE(3, 8);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(1, 16);
    bytes.writeUInt32LE(tableBytes, 20);
    if (stored) {
      bytes.writeUInt32LE(0x1234, 32);
      bytes.writeUInt32LE(tableBytes, 36);
    }
    const root = await createTestTempDirectory("rea-go-macho-table-");
    const path = join(root, "image");
    await writeFile(path, bytes);
    if (stored) await truncate(path, 32 + tableBytes);
    const provider = new GoBinaryProvider();
    try {
      const result = await provider.inspect({ path });
      if (result.ok) throw new Error("Expected a command-table refusal");
      const projected = projectAnalysisError(result.error);
      if (stored)
        expect(projected).toMatchObject({
          code: "resource_constraint",
          details: {
            reported_limits: {
              boundary: "max_structure_bytes",
              maximum: 16 * 1024 * 1024,
            },
            limit: {
              control_kind: "parameter",
              parameter: "max_structure_bytes",
              effective_value: 16 * 1024 * 1024,
            },
            refusal: { kind: "adjustable_budget" },
          },
        });
      else {
        expect(result.error).toBeInstanceOf(AnalysisTargetFailureError);
        if (!(result.error instanceof AnalysisTargetFailureError))
          throw result.error;
        expect(result.error.cause).toBeInstanceOf(BinaryFormatFailure);
        if (!(result.error.cause instanceof BinaryFormatFailure))
          throw result.error.cause;
        expect(result.error.cause.failure).toMatchObject({
          kind: "truncated",
          format: "macho",
          field: "Mach-O load commands",
          offset: 32,
        });
        expect(projected).toMatchObject({
          code: "unsupported_target",
          details: {
            failure_kind: "truncated",
            format: "macho",
            field: "Mach-O load commands",
            offset: 32,
          },
        });
      }
    } finally {
      await provider.close();
    }
  },
);

it("preserves the actual build-info byte guard as a resource failure", async () => {
  const fixture = createGoInlineAggregateFixture(1024 * 1024 + 2);
  const root = await createTestTempDirectory("rea-go-resource-");
  const path = join(root, "oversized-metadata.elf");
  await writeFile(path, fixture.bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  expect(result.ok).toBe(false);
  if (result.ok)
    throw new Error("Oversized embedded metadata must not succeed");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw result.error;
  expect(result.error.reason).toContain(path);
  expect(result.error.reportedLimits).toEqual({
    boundary: "build-info",
    maximum: GO_ANALYSIS_BUDGET_DEFAULTS.max_build_info_bytes,
  });
  const projected = projectAnalysisError(result.error);
  expect(projected.details?.limit).toMatchObject({
    control_kind: "parameter",
    parameter: "max_build_info_bytes",
    unit: "bytes",
  });
  expect(projected.retryable).toBe(false);
});

it("keeps the header-search budget distinct from a worker CPU limit", async () => {
  const root = await createTestTempDirectory("rea-go-search-");
  const path = join(root, "overlapping.elf");
  await writeFile(path, createGoOverlappingElfFixture());
  const result = await new GoBinaryProvider().inspect({ path });
  if (result.ok) throw new Error("Overlapping header search must be refused");
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({
    retryable: false,
    details: {
      resource: "cpu",
      reported_limits: {
        boundary: "search",
        maximum: GO_ANALYSIS_BUDGET_DEFAULTS.max_header_search_bytes,
      },
    },
  });
});

it("reports unreadable ELF names alongside the no-record limitation", async () => {
  const bytes = createGoBinaryFixture({ omitBuildInfo: true }).bytes;
  const nameTableHeader = 256 + 64;
  bytes.writeBigUInt64LE(0x800n, nameTableHeader + 8);
  bytes.writeBigUInt64LE(24n, nameTableHeader + 32);
  bytes.writeUInt32LE(3, 768);
  const root = await createTestTempDirectory("rea-go-unknown-section-names-");
  const path = join(root, "unknown-names.elf");
  await writeFile(path, bytes);

  const result = await new GoBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.build_info).toBeNull();
  expect(result.value.limitations).toContainEqual(
    expect.stringMatching(
      /section names.*unavailable.*compression type 3.*unsupported/iu,
    ),
  );
  expect(result.value).not.toHaveProperty("section_names_limitation");
});

it("keeps a module-mode build with no dependency records as an observed empty list", async () => {
  const moduleText =
    "path\texample.com/tool\n" +
    "mod\texample.com/tool\t(devel)\t\n" +
    "build\tGOOS=linux\n";
  const root = await createTestTempDirectory("rea-go-empty-module-deps-");
  const path = join(root, "application.elf");
  await writeFile(path, createGoBinaryFixture({ moduleText }).bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.build_info?.module_text).toBe(moduleText);
  expect(result.value.build_info?.module).toMatchObject({
    main: { path: "example.com/tool", version: "(devel)" },
    dependencies: [],
    complete: true,
  });
});

it("adjusts string_literals file offsets inside a universal Mach-O slice and records truncation", async () => {
  const rodata = Buffer.from(
    "ListResourceProvidersgenaihttps://example.invalid/v1",
    "utf8",
  );
  const thin = createGoRodataStringFixture({
    format: "macho",
    machoChainedFixups: true,
    rodata,
    headers: [
      { section: "data", offsetInSection: 0, ptr: 0x102000n, len: 21n },
      { section: "data", offsetInSection: 16, ptr: 0x102015n, len: 5n },
      { section: "data", offsetInSection: 32, ptr: 0x10201an, len: 26n },
    ],
  });
  const fat = universalMacho([
    { bytes: thin.bytes, cpuType: CPU_ARM64, cpuSubtype: 0 },
  ]);
  const sliceOffset = fat.slices[0]!.offset;
  const root = await createTestTempDirectory("rea-go-fat-strings-");
  const path = join(root, "universal-go");
  await writeFile(path, fat.bytes);

  const result = await new GoBinaryProvider().inspect({
    path,
    architecture: "arm64",
    include_string_literals: true,
    max_string_literals: 2,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.selected_slice?.offset).toBe(sliceOffset);
  expect(result.value.string_literals).toEqual({
    evidence_kind: "inferred",
    discovered_count: 3,
    aggregate_bytes: 26,
    max_items: 2,
    truncated: true,
    limits_reached: ["max_string_literals"],
    items: [
      {
        value: "ListResourceProviders",
        location: { offset: sliceOffset + thin.rodataOffset, bytes: 21 },
        first_header_offset: sliceOffset + thin.dataOffset,
        reference_count: 1,
      },
      {
        value: "genai",
        location: { offset: sliceOffset + thin.rodataOffset + 21, bytes: 5 },
        first_header_offset: sliceOffset + thin.dataOffset + 16,
        reference_count: 1,
      },
    ],
  });
  for (const item of result.value.string_literals?.items ?? []) {
    expect(
      fat.bytes
        .subarray(
          item.location.offset,
          item.location.offset + item.location.bytes,
        )
        .toString("utf8"),
    ).toBe(item.value);
  }
  expect(result.value.string_literals).toMatchObject({
    truncated: true,
    limits_reached: ["max_string_literals"],
  });
  // Chained fixups are not a field on the report. The limitation is the
  // record that pointer recovery can miss rebase-encoded slots.
  expect(result.value.limitations).toContain(
    "This Mach-O declares LC_DYLD_CHAINED_FIXUPS; rebase-encoded pointer slots in writable data may not hold raw virtual addresses statically, so (ptr, len) recovery can miss writable-section string headers.",
  );
});

it.each([
  [
    "max_input_bytes",
    4095,
    8192,
    { maximum_input_bytes: 4095, parameter: "max_input_bytes", unit: "bytes" },
  ],
  [
    "max_report_bytes",
    1,
    16384,
    { maximum_output_bytes: 1, parameter: "max_report_bytes", unit: "bytes" },
  ],
  ["max_build_info_bytes", 1, 4096, { boundary: "build-info", maximum: 1 }],
  ["max_header_search_bytes", 1, 4096, { boundary: "search", maximum: 1 }],
] as const)(
  "recovers the same Go artifact after increasing %s",
  async (parameter, low, raised, reportedLimits) => {
    const root = await createTestTempDirectory("rea-go-budget-recovery-");
    const path = join(root, "application.elf");
    await writeFile(path, createGoBinaryFixture().bytes);
    const service = new GoBinaryService(new GoBinaryProvider());
    try {
      const refused = await service.inspect({ path, [parameter]: low });
      if (refused.ok)
        throw new Error(
          "Selected low budget must refuse this complete artifact",
        );
      expect(projectAnalysisError(refused.error)).toMatchObject({
        code: "resource_constraint",
        details: {
          reported_limits: reportedLimits,
          limit: {
            control_kind: "parameter",
            parameter,
            unit: "bytes",
          },
        },
      });
      const recovered = await service.inspect({ path, [parameter]: raised });
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.normalized_result).toMatchObject({
        artifact: { path, bytes: 4096 },
        build_info: { go_version: "go1.26.0" },
      });
      expect(recovered.value.parameters).toEqual({ path, [parameter]: raised });
    } finally {
      await service.close();
    }
  },
);

it.each([
  ["max_string_literals", 1],
  ["max_string_literal_bytes", 3],
  ["max_string_bytes", 5],
  ["max_string_header_scan_bytes", 16],
  ["max_string_candidates", 1],
] as const)(
  "identifies and recovers the exact inferred-string limit %s",
  async (parameter, low) => {
    const fixture = createGoRodataStringFixture({
      format: "elf",
      rodata: Buffer.from("alphabeta"),
      headers: [
        { section: "data", offsetInSection: 0, ptr: 0x102000n, len: 5n },
        { section: "data", offsetInSection: 16, ptr: 0x102005n, len: 4n },
      ],
    });
    const root = await createTestTempDirectory(
      "rea-go-string-budget-recovery-",
    );
    const path = join(root, "strings.elf");
    await writeFile(path, fixture.bytes);
    const service = new GoBinaryService(new GoBinaryProvider());
    try {
      const selected = { path, include_string_literals: true };
      const limited = await service.inspect({ ...selected, [parameter]: low });
      if (!limited.ok) throw limited.error;
      expect(limited.value.normalized_result).toMatchObject({
        string_literals: { truncated: true, limits_reached: [parameter] },
      });
      const recovered = await service.inspect({
        ...selected,
        [parameter]: 1048576,
      });
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.normalized_result).toMatchObject({
        string_literals: {
          truncated: false,
          items: [{ value: "alpha" }, { value: "beta" }],
        },
      });
      expect(recovered.value.subject).toEqual(limited.value.subject);
    } finally {
      await service.close();
    }
  },
);

it("cancels a many-frame compressed ELF section-name table", async () => {
  const root = await createTestTempDirectory("rea-go-zstd-cancel-");
  const path = join(root, "app");
  await writeFile(path, elfFrameAllowanceFixture());
  const reason = new Error("stop go frames");
  const controller = new AbortController();
  const yieldImpl = scheduler.yield.bind(scheduler);
  let yields = 0;
  const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
    yields += 1;
    await yieldImpl();
    if (yields === 1) controller.abort(reason);
  });
  try {
    const result = await new GoBinaryProvider().inspect(
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "inspect_go_binary",
      cause: reason,
    });
  } finally {
    spy.mockRestore();
  }
});
