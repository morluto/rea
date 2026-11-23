import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { runWithAnalysisOperationSnapshot } from "../../../src/domain/analysisOperationSnapshot.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../../../src/domain/analysisResourceLimits.js";
import { createElfUnwindRangesService } from "../../../src/composition/binaryDiagnostics/elfUnwindRanges.js";
import { MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES } from "../../../src/domain/native/elfUnwindRanges.js";
import { elfUnwindFixture } from "../../../src/native/elf/ElfUnwindTables.fixture.js";
import { compressedElfNoteFixture } from "../../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("ELF unwind range stable filesystem boundary", () => {
  it("reports non-file and malformed ELF selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-elf-unwind-files-");
    const path = join(root, "program");
    const alias = join(root, "alias");
    const malformed = join(root, "malformed");
    await writeFile(path, elfUnwindFixture());
    await writeFile(malformed, Buffer.from("not an elf"));
    await symlink(path, alias);
    const service = createElfUnwindRangesService();
    try {
      for (const [candidate, reason] of [
        [root, "invalid_format"],
        [alias, "invalid_format"],
        [malformed, "invalid_format"],
        [join(root, "missing"), "invalid_value"],
        [join(path, "child"), "invalid_value"],
      ] as const) {
        const result = await service.inspect({ path: candidate });
        if (result.ok) throw new Error("Expected file acquisition failure");
        expect(result.error).toMatchObject({
          _tag: "AnalysisInputError",
          operation: "inspect_elf_unwind_ranges",
          issues: [
            {
              path: ["path"],
              reason,
              message: expect.any(String),
            },
          ],
        });
      }
    } finally {
      await service.close();
    }
  });

  it("accepts a header whose search table is omitted, as GNU ld writes it", async () => {
    const root = await createTestTempDirectory("rea-elf-unwind-omit-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfUnwindFixture({ header: "match", headerCount: "omit" }),
    );
    const service = createElfUnwindRangesService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.normalized_result).toMatchObject({
        eh_frame_hdr: { status: "present", fde_count: null, table_entries: 0 },
        coverage: { status: "complete", eh_frame_hdr_agreement: "unavailable" },
      });
    } finally {
      await service.close();
    }
  });

  it("returns an ELF32 range whose end wraps at the address width", async () => {
    const root = await createTestTempDirectory("rea-elf-unwind-wrap-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfUnwindFixture({
        bits: 32,
        header: "match",
        unsignedPcrel: { size: 0xffffff00 },
      }),
    );
    const service = createElfUnwindRangesService();
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      const report = result.value.normalized_result as {
        ranges: { start: string; end: string; size: string }[];
      };
      const first = report.ranges[0];
      if (first === undefined) throw new Error("Expected a range");
      expect(first.size).toBe(String(0xffffff00));
      expect(BigInt(first.end)).toBe(
        BigInt.asUintN(32, BigInt(first.start) + 0xffffff00n),
      );
    } finally {
      await service.close();
    }
  });
});

describe("ELF unwind range budgets", () => {
  it("tells a caller over the symbol-name text allowance to request a smaller page", async () => {
    const root = await createTestTempDirectory("rea-elf-unwind-names-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfUnwindFixture({ header: "absent", suffixNames: 300 }),
    );
    const service = createElfUnwindRangesService();
    try {
      const result = await service.inspect({ path, limit: 300 });
      if (result.ok) throw new Error("Expected symbol-name text failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        retryable: false,
        reportedLimits: {
          limit: 300,
          maximum_bytes: MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES,
        },
        cause: {
          failure: {
            kind: "limit",
            format: "elf-unwind-ranges",
            limit: {
              name: "symbol_name_text_bytes",
              maximum: MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES,
            },
          },
        },
      });
      const remediation =
        "remediationAction" in result.error
          ? result.error.remediationAction
          : undefined;
      expect(remediation).toContain("smaller limit than 300");
      expect(remediation).not.toContain("Raise max_ranges");
      const smaller = await service.inspect({ path, limit: 200 });
      expect(smaller.ok).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-elf-unwind-budget-");
    const path = join(root, "program");
    await writeFile(path, elfUnwindFixture());
    const service = createElfUnwindRangesService();
    try {
      const tooSmall = await service.inspect({ path, max_file_bytes: 64 });
      if (tooSmall.ok) throw new Error("Expected resource budget failure");
      expect(tooSmall.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        resource: "file-size",
        reportedLimits: { max_file_bytes: 64 },
      });
      const tooMany = await service.inspect({ path, max_ranges: 1 });
      if (tooMany.ok) throw new Error("Expected range budget failure");
      expect(tooMany.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        resource: "capacity",
        reportedLimits: { max_ranges: 1 },
        cause: {
          failure: {
            kind: "limit",
            format: "elf-unwind-ranges",
            field: "CIE",
            offset: expect.any(Number),
            limit: { name: "max_ranges", maximum: 1 },
          },
        },
      });
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

it("projects a section-name frame cap as an adjustable zstd.max_frames limit", async () => {
  const root = await createTestTempDirectory("rea-elf-unwind-zstd-");
  const path = join(root, "program");
  const frame = Buffer.from([
    0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, 0x61,
  ]);
  await writeFile(
    path,
    compressedElfNoteFixture(
      64,
      true,
      2,
      ".note.gnu.build-id",
      Buffer.concat([frame, frame]),
    ),
  );
  const service = createElfUnwindRangesService();
  try {
    const result = await runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "zstd.max_frames": 1 } },
      () => service.inspect({ path }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      operation: "inspect_elf_unwind_ranges",
      resource: "cpu",
      limit: {
        setting: "zstd.max_frames",
        effective_value: 1,
        source: "runtime",
        minimum: MINIMUM_ZSTD_MAX_FRAMES,
        maximum: MAXIMUM_ZSTD_MAX_FRAMES,
        unit: "count",
      },
    });
  } finally {
    await service.close();
  }
});

it("cancels a many-frame compressed section-name table", async () => {
  const root = await createTestTempDirectory("rea-elf-unwind-cancel-");
  const path = join(root, "program");
  const frame = Buffer.from([
    0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, 0x61,
  ]);
  const frames = Buffer.alloc(frame.length * 32);
  for (let index = 0; index < 32; index += 1)
    frame.copy(frames, index * frame.length);
  await writeFile(
    path,
    compressedElfNoteFixture(64, true, 2, ".note.gnu.build-id", frames),
  );
  const reason = new Error("stop unwind frames");
  const controller = new AbortController();
  const yieldImpl = scheduler.yield.bind(scheduler);
  let yields = 0;
  const spy = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
    yields += 1;
    await yieldImpl();
    if (yields === 1) controller.abort(reason);
  });
  const service = createElfUnwindRangesService();
  try {
    const result = await service.inspect(
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "inspect_elf_unwind_ranges",
      cause: reason,
    });
  } finally {
    spy.mockRestore();
    await service.close();
  }
});
