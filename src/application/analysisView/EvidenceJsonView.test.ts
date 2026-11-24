import { describe, expect, it } from "vitest";

import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { inspectAnalysisViewValidated } from "./AnalysisViewService.js";
import { DEFAULT_EVIDENCE_JSON_PAGE_BYTES } from "../../domain/analysisView/evidenceJsonView.js";
import { DEFAULT_AGENT_RESULT_BUDGET_BYTES } from "../../domain/analysisResourceLimits.js";

const parentEvidence = (): Evidence =>
  createEvidence(
    { path: "/fixture/sample.bin", sha256: "c".repeat(64), format: "elf" },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "inspect_byte_entropy",
      parameters: {},
      // A non-BMP character makes a page boundary able to split a surrogate pair.
      result: {
        rows: Array.from({ length: 200 }, (_, index) => ({
          index,
          label: `row ${String(index)} \u{1F600}`,
        })),
      },
      limitations: ["fixture limitation"],
    },
  );

type PageResult = {
  readonly text: string;
  readonly coverage: {
    readonly next_offset: number | null;
    readonly total: number;
    readonly exhausted: boolean;
  };
};

const page = (
  ledger: EvidenceLedger,
  evidenceId: string,
  offset: number,
  limit: number,
): PageResult => {
  const projected = inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: evidenceId },
      view: { kind: "evidence-json", offset, limit },
    },
    (id) => ledger.forAnalysis(id),
  );
  if (!projected.ok) throw projected.error;
  return projected.value.normalized_result as unknown as PageResult;
};

describe("evidence-json view", () => {
  it("reproduces the complete retained Evidence when every page is joined", () => {
    const parent = parentEvidence();
    const ledger = new EvidenceLedger();
    expect(ledger.record(parent).ok).toBe(true);
    const retained = ledger.forAnalysis(parent.evidence_id)!;
    const expected = JSON.stringify(retained);

    const pages: string[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null) {
      const result = page(ledger, parent.evidence_id, offset, 257);
      expect(result.coverage.total).toBe(expected.length);
      pages.push(result.text);
      offset = result.coverage.next_offset;
      calls += 1;
      expect(calls).toBeLessThan(10_000);
    }
    const joined = pages.join("");
    expect(joined).toBe(expected);
    expect(JSON.parse(joined)).toEqual(JSON.parse(JSON.stringify(parent)));
    // No page ends between the halves of a surrogate pair.
    for (const text of pages.slice(0, -1)) {
      const last = text.charCodeAt(text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("keeps a surrogate pair whole even in a one-unit page", () => {
    const parent = parentEvidence();
    const ledger = new EvidenceLedger();
    expect(ledger.record(parent).ok).toBe(true);
    const text = JSON.stringify(ledger.forAnalysis(parent.evidence_id));
    const pair = text.indexOf("\u{1F600}");
    const result = page(ledger, parent.evidence_id, pair, 1);
    expect(result.text).toBe("\u{1F600}");
    expect(result.coverage.next_offset).toBe(pair + 2);
  });

  it("sizes an omitted limit by escaped UTF-8 bytes, not code units", () => {
    // Three-byte characters and quotes would overflow a code-unit page.
    const parent = createEvidence(
      { path: "/fixture/wide.bin", sha256: "d".repeat(64), format: "elf" },
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "inspect_byte_entropy",
        parameters: {},
        result: { text: '中"'.repeat(40_000) },
      },
    );
    const ledger = new EvidenceLedger();
    expect(ledger.record(parent).ok).toBe(true);
    const projected = inspectAnalysisViewValidated(
      {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: { kind: "evidence-json", offset: 0 },
      },
      (id) => ledger.forAnalysis(id),
    );
    if (!projected.ok) throw projected.error;
    const { text } = projected.value.normalized_result as unknown as PageResult;
    expect(Buffer.byteLength(JSON.stringify(text)) - 2).toBeLessThanOrEqual(
      DEFAULT_EVIDENCE_JSON_PAGE_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(projected.value))).toBeLessThan(
      DEFAULT_AGENT_RESULT_BUDGET_BYTES,
    );
  });

  it("reports an exhausted empty page past the end", () => {
    const parent = parentEvidence();
    const ledger = new EvidenceLedger();
    expect(ledger.record(parent).ok).toBe(true);
    const total = JSON.stringify(ledger.forAnalysis(parent.evidence_id)).length;
    const result = page(ledger, parent.evidence_id, total + 10, 64);
    expect(result.text).toBe("");
    expect(result.coverage).toMatchObject({
      next_offset: null,
      exhausted: true,
    });
  });
});
