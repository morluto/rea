import { describe, expect, it } from "vitest";
import type { NativeAotParserLimits } from "./nativeAotPe.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  NATIVE_AOT_MAX_REPORT_BYTES,
  parseNativeAotPe,
} from "./nativeAotPe.js";
import {
  nativeAotPeDigest,
  nativeAotPeFixture,
} from "../../../tests/fixtures/nativeaotPe.js";

const REPORT_BUDGET = NATIVE_AOT_MAX_REPORT_BYTES;

describe("NativeAOT parser resource budgets", () => {
  it("reports source-cap rejection without hashing or inventing omitted-byte coverage", () => {
    const bytes = nativeAotPeFixture();
    const sha = nativeAotPeDigest(bytes);
    const limits: NativeAotParserLimits = {
      sourceBytes: bytes.length - 1,
      workUnits: 1024,
      workingMemoryBytes: 1024,
    };
    const report = parseNativeAotPe(
      bytes,
      sha,
      REPORT_BUDGET,
      undefined,
      limits,
    ).summary;
    expect(report).toMatchObject({
      status: "partial",
      reason: {
        code: "source_byte_budget",
        limit_bytes: bytes.length - 1,
        observed_bytes: bytes.length,
        runtime_override: false,
      },
      analysis_artifact_sha256: sha,
      header_address: null,
      diagnostics: ["source_byte_budget"],
      coverage: {
        source_bytes_examined: 0,
        source_byte_budget_bytes: bytes.length - 1,
        truncation_reason: "source-byte-budget",
      },
    });
    expect(report.coverage.source_bytes_omitted).toBeUndefined();
  });
});

it.each([8, 1024, 1272])(
  "retains every eligible section in RTR omission coverage after %s work units",
  (workUnits) => {
    const bytes = Buffer.alloc(0xc00);
    nativeAotPeFixture().copy(bytes);
    bytes.writeUInt16LE(4, 0x86);
    bytes.writeUInt32LE(0x5000, 0x98 + 56);
    bytes.writeUInt32LE(0, 0x600); // Scan every candidate rather than stop at a header.
    for (let index = 0; index < 2; index += 1) {
      const row = 0x98 + 0xf0 + (index + 2) * 40;
      bytes.writeUInt32LE(0x100, row + 8);
      bytes.writeUInt32LE(0x3000 + index * 0x1000, row + 12);
      bytes.writeUInt32LE(0x100, row + 16);
      bytes.writeUInt32LE(0xa00 + index * 0x100, row + 20);
      bytes.writeUInt32LE(0x40000040, row + 36);
    }
    const summary = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      REPORT_BUDGET,
      undefined,
      { sourceBytes: bytes.length, workingMemoryBytes: 64 * 1024, workUnits },
    ).summary;
    // 127 aligned candidates in .rdata, then 31 in each authored extra section.
    expect(summary.coverage.rtr_signature_scan_bytes_examined).toBe(workUnits);
    expect(summary.coverage.rtr_signature_scan_bytes_omitted).toBe(
      1512 - workUnits,
    );
  },
);

describe("NativeAOT parser report admission", () => {
  it("never returns an over-budget report from early exits", () => {
    const bytes = nativeAotPeFixture();
    const sha = nativeAotPeDigest(bytes);
    const expectReportBudget = (run: () => void): void => {
      let caught: unknown;
      try {
        run();
      } catch (cause: unknown) {
        caught = cause;
      }
      expect(caught).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        resource: "capacity",
        retryable: false,
        diagnostics: { code: "report_budget_too_small" },
        reportedLimits: { maximum_summary_bytes: 0 },
      });
    };
    expectReportBudget(() => {
      parseNativeAotPe(bytes, sha, 0, undefined, {
        sourceBytes: bytes.length - 1,
        workUnits: 1024,
        workingMemoryBytes: 1024,
      });
    });
    const nonPe = Buffer.from("not a PE image");
    expectReportBudget(() => {
      parseNativeAotPe(nonPe, nativeAotPeDigest(nonPe), 0);
    });
  });

  it("does not claim a missing RTR header when signature coverage hits the work limit", () => {
    const bytes = nativeAotPeFixture();
    const limits: NativeAotParserLimits = {
      sourceBytes: bytes.length,
      workUnits: 8,
      workingMemoryBytes: 1024,
    };
    const report = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      REPORT_BUDGET,
      undefined,
      limits,
    ).summary;
    expect(report).toMatchObject({
      status: "partial",
      header_address: null,
      truncated: true,
      coverage: {
        rtr_signature_scan_bytes_examined: 8,
        rtr_signature_scan_bytes_omitted: expect.any(Number),
        truncation_reason: "work-unit-budget",
      },
    });
    expect(report.reason).toEqual({
      code: "rtr_scan_budget",
      runtime_override: false,
    });
  });

  it("does not claim a missing root when table discovery is incomplete", () => {
    const bytes = nativeAotPeFixture();
    const report = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      REPORT_BUDGET,
      undefined,
      {
        sourceBytes: bytes.length,
        workUnits: 10_000,
        workingMemoryBytes: 1024,
      },
    ).summary;
    expect(report.truncated).toBe(true);
    expect(report.reason).toMatchObject({
      code: "system_object_root_unproven",
      runtime_override: false,
    });
  });
});

describe("NativeAOT hydration resource budgets", () => {
  it("explains a hydration work budget on the partial report", () => {
    const bytes = nativeAotPeFixture();
    // A 100-byte zero-fill fits the 128 mapped bytes at RVA 0x2380.
    bytes.writeBigUInt64LE(0x140002106n, 0x620);
    bytes[0x704] = 0xe9;
    bytes[0x705] = 72;
    const sha = nativeAotPeDigest(bytes);
    const control = parseNativeAotPe(bytes, sha, REPORT_BUDGET).summary;
    expect(control.status).toBe("complete");
    expect(control.derived_overlay).toEqual({
      address: "0x140002380",
      size_bytes: 100,
      sha256: nativeAotPeDigest(Buffer.alloc(100)),
    });
    const summary = parseNativeAotPe(bytes, sha, REPORT_BUDGET, undefined, {
      sourceBytes: bytes.length,
      workUnits: 1150,
      workingMemoryBytes: 1024 * 1024,
    }).summary;
    expect(summary.status).toBe("partial");
    expect(summary.reason).toEqual({
      code: "system_object_root_unproven",
      runtime_override: false,
      hydration: { detail: "work_budget", runtime_override: false },
    });
    expect(summary.diagnostics).toEqual(["work_budget"]);
    expect(summary.derived_overlay).toBeNull();
  });

  it("does not describe unexamined hydration source bytes as missing", () => {
    const bytes = nativeAotPeFixture();
    const summary = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      REPORT_BUDGET,
      undefined,
      {
        sourceBytes: bytes.length,
        workUnits: 1082,
        workingMemoryBytes: 64 * 1024,
      },
    ).summary;
    expect(summary.reason).toMatchObject({
      code: "system_object_root_unproven",
      hydration: { detail: "work_budget", runtime_override: false },
    });
    expect(summary.diagnostics).toEqual(["work_budget"]);
    expect(summary.coverage.truncation_reason).toBe("work-unit-budget");
  });

  it.each([0, 64])(
    "reports hydration memory exhaustion independently of valid section capacity (%i bytes)",
    (workingMemoryBytes) => {
      const bytes = nativeAotPeFixture();
      // This is the same valid 100-byte overlay as the normal-budget control
      // above: RVA0x2380 has128 mapped bytes, independently of this limit.
      bytes.writeBigUInt64LE(0x140002106n, 0x620);
      bytes[0x704] = 0xe9;
      bytes[0x705] = 72;
      const summary = parseNativeAotPe(
        bytes,
        nativeAotPeDigest(bytes),
        REPORT_BUDGET,
        undefined,
        { sourceBytes: bytes.length, workUnits: 65536, workingMemoryBytes },
      ).summary;
      expect(summary.status).toBe("partial");
      expect(summary.diagnostics).toEqual(["working_memory_budget"]);
      expect(summary.coverage.truncation_reason).toBe("working-memory-budget");
      expect(summary.reason).toMatchObject({
        hydration: { detail: "working_memory_budget", runtime_override: false },
      });
    },
  );
});

describe("NativeAOT detail and summary byte accounting", () => {
  it("gives each detail request its own work budget without consuming the cached summary", () => {
    const bytes = nativeAotPeFixture();
    const source = Buffer.from(bytes);
    const parsed = parseNativeAotPe(
      bytes,
      nativeAotPeDigest(bytes),
      REPORT_BUDGET,
      undefined,
      {
        sourceBytes: bytes.length,
        workUnits: 4096,
        workingMemoryBytes: 64 * 1024,
      },
    );
    expect(parsed.summary.status).toBe("complete");
    // Fixture RVA 0x2280 maps to .rdata file offset 0x880; this is the
    // independently authored 32-byte MethodTable, including its one slot.
    const expectedMemory = {
      size_bytes: 32,
      sha256: nativeAotPeDigest(bytes.subarray(0x880, 0x8a0)),
    };
    const summary = JSON.stringify(parsed.summary);
    for (let request = 0; request < 512; request++) {
      expect(
        parsed.readTypeDetail("0x140002280", REPORT_BUDGET),
        `request ${String(request)}`,
      ).toMatchObject({
        status: "complete",
        truncated: false,
        virtual_slots: [{ slot: 0, target_address: "0x140001040" }],
        derived_memory: expectedMemory,
      });
    }
    expect(JSON.stringify(parsed.summary)).toBe(summary);
    expect(bytes.equals(source)).toBe(true);
  });

  it("admits serialized MethodTable memory descriptors before emitting them", () => {
    const bytes = nativeAotPeFixture();
    const sha = nativeAotPeDigest(bytes);
    const detail = (budget: number) =>
      parseNativeAotPe(bytes, sha, REPORT_BUDGET).readTypeDetail(
        "0x140002280",
        budget,
      );
    const complete = detail(REPORT_BUDGET);
    expect(complete?.derived_memory).toEqual(expect.any(Object));
    let low = 0;
    let high = Buffer.byteLength(JSON.stringify(complete));
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (detail(middle)?.derived_memory != null) high = middle;
      else low = middle + 1;
    }
    const atBoundary = detail(low);
    const belowBoundary = detail(low - 1);
    expect(atBoundary?.derived_memory).toEqual(expect.any(Object));
    expect(Buffer.byteLength(JSON.stringify(atBoundary))).toBeLessThanOrEqual(
      low,
    );
    expect(belowBoundary?.derived_memory ?? null).toBeNull();
    expect(belowBoundary?.diagnostics).toContain("detail_rows_omitted");
    expect(
      belowBoundary === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(belowBoundary)),
    ).toBeLessThanOrEqual(low - 1);
  });

  it("truncates report rows before exceeding its JSON byte budget", () => {
    const bytes = nativeAotPeFixture();
    const sha = nativeAotPeDigest(bytes);
    const complete = parseNativeAotPe(bytes, sha, REPORT_BUDGET);
    const fullBytes = Buffer.byteLength(JSON.stringify(complete.summary));
    let budget = fullBytes - 1;
    let summary: ReturnType<typeof parseNativeAotPe>["summary"] | undefined;
    while (budget > 0) {
      try {
        const candidate = parseNativeAotPe(bytes, sha, budget);
        if (candidate.summary.truncated) {
          summary = candidate.summary;
          break;
        }
      } catch (cause: unknown) {
        // Budgets below the fixed report header cannot carry an honest summary.
        expect(cause).toBeInstanceOf(AnalysisResourceConstraintError);
        expect(cause).toMatchObject({
          diagnostics: { code: "summary_exceeds_budget" },
          retryable: false,
        });
      }
      budget--;
    }
    if (summary === undefined)
      throw new Error("No partial summary budget found");
    expect(summary.truncated).toBe(true);
    expect(
      (summary.types_omitted ?? 0) +
        (summary.frozen_strings_omitted ?? 0) +
        (summary.coverage.scan_bytes_omitted ?? 0) +
        (summary.coverage.frozen_scan_bytes_omitted ?? 0),
    ).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(
      budget,
    );
  });
});

it("retains the index memory refusal after successful hydration", () => {
  const bytes = nativeAotPeFixture();
  const report = parseNativeAotPe(
    bytes,
    nativeAotPeDigest(bytes),
    REPORT_BUDGET,
    undefined,
    {
      sourceBytes: bytes.length,
      workUnits: 65536,
      workingMemoryBytes: 16,
    },
  ).summary;
  expect(report.derived_overlay).toMatchObject({
    address: "0x140002380",
    size_bytes: 1,
    sha256: nativeAotPeDigest(Buffer.alloc(1)),
  });
  expect(report.diagnostics).toEqual([]);
  expect(report.reason).toMatchObject({ code: "system_object_root_unproven" });
  expect(report.coverage.truncation_reason).toBe("working-memory-budget");
});

it("reports a frozen-string scan stopped during a budgeted image read", () => {
  const bytes = nativeAotPeFixture();
  const sha = nativeAotPeDigest(bytes);
  const limits = {
    sourceBytes: bytes.length,
    workUnits: 3260,
    workingMemoryBytes: 64 * 1024,
  };
  const complete = parseNativeAotPe(bytes, sha, REPORT_BUDGET).summary;
  expect(complete.status).toBe("complete");
  expect(complete.frozen_strings).not.toHaveLength(0);
  const partial = parseNativeAotPe(
    bytes,
    sha,
    REPORT_BUDGET,
    undefined,
    limits,
  ).summary;
  expect(partial).toMatchObject({
    status: "partial",
    truncated: true,
    reason: { code: "truncated", truncation_reason: "work-unit-budget" },
    coverage: { truncation_reason: "work-unit-budget" },
  });
  expect(partial.frozen_strings).toEqual(complete.frozen_strings);
});
