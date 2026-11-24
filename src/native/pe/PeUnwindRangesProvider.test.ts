import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisMalformedTargetError } from "../../domain/analysisErrorCore.js";
import {
  inspectPeUnwindRangesInputSchema,
  type PeUnwindRanges,
} from "../../domain/native/peUnwindRanges.js";
import {
  peUnwindImage,
  runtimeFunction,
  unwindInfo,
  type PeUnwindFixtureOptions,
} from "./PeUnwindRanges.fixture.js";
import { PeUnwindRangesProvider } from "./PeUnwindRangesProvider.js";
import { createPeUnwindRangesService } from "../../composition/binaryDiagnostics/peUnwindRanges.js";

const inspect = async (
  options: PeUnwindFixtureOptions,
  input: Record<string, unknown> = {},
) => {
  const path = join(
    await createTestTempDirectory("rea-pe-unwind-"),
    "image.exe",
  );
  await writeFile(path, peUnwindImage(options));
  const provider = new PeUnwindRangesProvider();
  try {
    return await provider.inspect(
      inspectPeUnwindRangesInputSchema.parse({ path, limit: 64, ...input }),
    );
  } finally {
    await provider.close();
  }
};

const report = async (
  options: PeUnwindFixtureOptions,
  input: Record<string, unknown> = {},
): Promise<PeUnwindRanges> => {
  const result = await inspect(options, input);
  if (!result.ok) throw result.error;
  return result.value;
};

/** A hot function, its cold chained split, a two-level chain and an indirect chain. */
const primary = { begin: 0x1000, end: 0x1100, unwind: 0x2000 };
const coldSplit = { begin: 0x1100, end: 0x1180, unwind: 0x2100 };
const CHAINED_IMAGE: PeUnwindFixtureOptions = {
  entries: [
    primary,
    coldSplit,
    // Low bit set: the unwind RVA names the primary RUNTIME_FUNCTION itself.
    { begin: 0x1200, end: 0x1280, unwind: 0x2200 | 1 },
    { begin: 0x1300, end: 0x1310, unwind: 0x2300 },
    { begin: 0x1400, end: 0x1400, unwind: 0x2400 },
    { begin: 0x1500, end: 0x1520, unwind: 0x9000 },
  ],
  blobs: [
    { rva: 0x2000, bytes: unwindInfo(0x1, 3) },
    { rva: 0x2100, bytes: unwindInfo(0x4, 1, primary) },
    { rva: 0x2200, bytes: runtimeFunction(primary) },
    { rva: 0x2300, bytes: unwindInfo(0x4, 0, coldSplit) },
    { rva: 0x2400, bytes: unwindInfo(0, 0) },
  ],
};

describe("x64 PE exception directory", () => {
  it("separates primary function entries from chained fragments", async () => {
    const value = await report(CHAINED_IMAGE);
    expect(value.exception_directory).toEqual({
      status: "present",
      rva: "0x3000",
      size: 72,
      file_offset: 0x2400,
      section: ".pdata",
    });
    expect(value.image_base).toBe("0x140000000");
    expect(value.coverage).toEqual({
      status: "partial",
      total_entries: 6,
      primary_entries: 2,
      chained_entries: 3,
      unknown_entries: 1,
      entries_with_issues: 2,
      trailing_bytes: 0,
    });
    const [hot, cold, indirect, nested, empty, unmapped] = value.entries;
    expect(hot).toMatchObject({
      kind: "primary",
      unwind_version: 1,
      unwind_flags: ["ehandler"],
      unwind_code_count: 3,
      parent: null,
      primary_index: 0,
      issues: [],
    });
    expect(cold).toMatchObject({
      kind: "chained",
      unwind_flags: ["chaininfo"],
      parent: {
        begin_rva: "0x1000",
        end_rva: "0x1100",
        unwind_rva: "0x2000",
        index: 0,
      },
      primary_index: 0,
    });
    expect(indirect).toMatchObject({
      kind: "chained",
      unwind_rva: "0x2201",
      unwind_version: null,
      parent: { begin_rva: "0x1000", index: 0 },
      primary_index: 0,
    });
    // Two levels: this fragment extends the cold split, which extends the hot entry.
    expect(nested).toMatchObject({
      kind: "chained",
      parent: { begin_rva: "0x1100", index: 1 },
      primary_index: 0,
    });
    expect(empty).toMatchObject({ kind: "primary", issues: ["empty_range"] });
    expect(unmapped).toMatchObject({
      kind: "unknown",
      primary_index: null,
      issues: ["unwind_unmapped"],
    });
  });

  it("pages one kind while counting every entry", async () => {
    const value = await report(CHAINED_IMAGE, { kind: "chained", limit: 2 });
    expect(value.entries.map(({ index }) => index)).toEqual([1, 2]);
    expect(value.page).toEqual({
      kind: "chained",
      offset: 0,
      limit: 2,
      returned: 2,
      total: 3,
      next_offset: 2,
    });
    expect(value.coverage.total_entries).toBe(6);
    const counts = await report(CHAINED_IMAGE, { limit: 0 });
    expect(counts.entries).toEqual([]);
    expect(counts.page).toMatchObject({
      returned: 0,
      total: 6,
      next_offset: 0,
    });
  });

  it("keeps an unsorted table, a missing chain parent and trailing bytes explicit", async () => {
    const value = await report({
      entries: [
        { begin: 0x1100, end: 0x1200, unwind: 0x2000 },
        { begin: 0x1000, end: 0x1080, unwind: 0x2100 },
      ],
      blobs: [
        { rva: 0x2000, bytes: unwindInfo(0, 0) },
        {
          rva: 0x2100,
          bytes: unwindInfo(0x4, 0, {
            begin: 0x1800,
            end: 0x1900,
            unwind: 0x2000,
          }),
        },
      ],
      directorySize: 2 * 12 + 5,
    });
    expect(value.coverage).toMatchObject({
      total_entries: 2,
      chained_entries: 1,
      trailing_bytes: 5,
    });
    expect(value.entries[1]).toMatchObject({
      kind: "chained",
      parent: { begin_rva: "0x1800", index: null },
      primary_index: null,
      issues: ["unsorted", "chain_parent_missing"],
    });
  });
});

describe("x64 PE exception directory service failures", () => {
  it("returns typed resource and cancellation failures", async () => {
    const path = join(
      await createTestTempDirectory("rea-pe-unwind-budget-"),
      "app.exe",
    );
    await writeFile(path, peUnwindImage(CHAINED_IMAGE));
    const service = createPeUnwindRangesService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
      expect(tooSmall.error).toMatchObject({
        resource: "capacity",
        limit: { parameter: "max_file_bytes" },
      });
      const paddedPath = join(
        await createTestTempDirectory("rea-pe-unwind-padded-"),
        "padded.exe",
      );
      const padded = Buffer.concat([
        peUnwindImage(CHAINED_IMAGE),
        Buffer.alloc(131_072),
      ]);
      await writeFile(paddedPath, padded);
      const fitsReadBudget = await service.inspect({
        path: paddedPath,
        max_file_bytes: 80_000,
      });
      expect(fitsReadBudget.ok).toBe(true);
      const cancelled = await service.inspect(
        { path },
        { signal: AbortSignal.abort() },
      );
      if (cancelled.ok) throw new Error("Expected cancellation");
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    } finally {
      await service.close();
    }
  });
});

describe("x64 PE exception directory refusals and absence", () => {
  it("finds a chain parent listed after its fragment in an unsorted table", async () => {
    const value = await report({
      entries: [
        { begin: 0x1100, end: 0x1180, unwind: 0x2100 },
        { begin: 0x1000, end: 0x1080, unwind: 0x2000 },
      ],
      blobs: [
        { rva: 0x2000, bytes: unwindInfo(0, 0) },
        {
          rva: 0x2100,
          bytes: unwindInfo(0x4, 0, {
            begin: 0x1000,
            end: 0x1080,
            unwind: 0x2000,
          }),
        },
      ],
    });
    expect(value.entries[0]).toMatchObject({
      kind: "chained",
      parent: { begin_rva: "0x1000", index: 1 },
      primary_index: 1,
      issues: [],
    });
    expect(value.entries[1]!.issues).toEqual(["unsorted"]);
  });

  it("keeps unreadable codes, mismatched parents and unsorted overlaps explicit", async () => {
    const value = await report({
      entries: [
        primary,
        // Its code array runs past the end of the last file-backed section.
        { begin: 0x1200, end: 0x1280, unwind: 0x3ffc },
        // Its embedded parent begins at the primary entry but ends elsewhere.
        { begin: 0x1300, end: 0x1380, unwind: 0x2100 },
        // Unsorted and overlapping the previous range.
        { begin: 0x1340, end: 0x1390, unwind: 0x2200 },
      ],
      blobs: [
        { rva: 0x2000, bytes: unwindInfo(0, 0) },
        {
          rva: 0x2100,
          bytes: unwindInfo(0x4, 0, { ...primary, end: 0x1050 }),
        },
        { rva: 0x2200, bytes: unwindInfo(0, 0) },
        { rva: 0x3ffc, bytes: unwindInfo(0, 10).subarray(0, 4) },
      ],
    });
    const [, codes, mismatched, overlapping] = value.entries;
    expect(codes).toMatchObject({
      kind: "unknown",
      unwind_version: 1,
      unwind_code_count: 10,
      issues: ["unwind_codes_unmapped"],
    });
    expect(mismatched).toMatchObject({
      kind: "chained",
      parent: { begin_rva: "0x1000", end_rva: "0x1050", index: null },
      primary_index: null,
      issues: ["chain_parent_mismatch"],
    });
    expect(overlapping!.issues).toEqual(["overlaps_previous"]);
    expect(value.coverage.status).toBe("partial");
  });

  it("resolves the exact parent among entries that share a begin RVA", async () => {
    const second = { begin: 0x1000, end: 0x1100, unwind: 0x2200 };
    const value = await report({
      entries: [
        { begin: 0x1000, end: 0x1080, unwind: 0x2000 },
        second,
        { begin: 0x1200, end: 0x1280, unwind: 0x2100 },
      ],
      blobs: [
        { rva: 0x2000, bytes: unwindInfo(0, 0) },
        { rva: 0x2100, bytes: unwindInfo(0x4, 0, second) },
        { rva: 0x2200, bytes: unwindInfo(0, 0) },
      ],
    });
    expect(value.entries[2]).toMatchObject({
      kind: "chained",
      parent: { end_rva: "0x1100", index: 1 },
      primary_index: 1,
    });
  });

  it("reports both order and overlap for an out-of-order range", async () => {
    const value = await report({
      entries: [
        { begin: 0x1100, end: 0x1200, unwind: 0x2000 },
        { begin: 0x1080, end: 0x1180, unwind: 0x2000 },
      ],
      blobs: [{ rva: 0x2000, bytes: unwindInfo(0, 0) }],
    });
    expect(value.entries[1]!.issues).toEqual(["unsorted", "overlaps_previous"]);
  });

  it("reports an absent directory and an unsupported entry format", async () => {
    const absent = await report({ entries: [], directoryRva: 0 });
    expect(absent.exception_directory.status).toBe("absent");
    expect(absent.coverage).toMatchObject({
      status: "complete",
      total_entries: 0,
    });
    const arm64 = await report({
      entries: [primary],
      blobs: [{ rva: 0x2000, bytes: unwindInfo(0, 0) }],
      machine: 0xaa64,
    });
    expect(arm64.exception_directory.status).toBe("unsupported_machine");
    expect(arm64.coverage).toMatchObject({
      status: "partial",
      total_entries: 0,
    });
  });

  it.each([
    [
      "a directory outside every file-backed section",
      { entries: [primary], directoryRva: 0x9000 },
    ],
    [
      "a declared size with a zero RVA",
      { entries: [primary], directoryRva: 0 },
    ],
    [
      "an oversized entry count whose directory leaves the file",
      { entries: [], directorySize: (2_097_152 + 1) * 12 },
    ],
    [
      "a directory whose trailing bytes leave the last section",
      { entries: [], directoryRva: 0x3ff4, directorySize: 13 },
    ],
    [
      "a file cut inside the directory",
      { entries: [primary], truncateTo: 0x2400 + 6 },
    ],
  ] satisfies [string, PeUnwindFixtureOptions][])(
    "refuses %s as a malformed target",
    async (_name, options) => {
      const result = await inspect(options);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(AnalysisMalformedTargetError);
    },
  );
});
