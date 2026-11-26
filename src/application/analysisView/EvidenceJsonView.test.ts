import { describe, expect, it, vi } from "vitest";

import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { inspectAnalysisViewValidated } from "./AnalysisViewService.js";
import {
  DEFAULT_EVIDENCE_JSON_PAGE_BYTES,
  EvidenceJsonSerializationCache,
  projectEvidenceJsonView,
} from "../../domain/analysisView/evidenceJsonView.js";
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

  it("pages a record it does not cache from a window, matching the cached pages", () => {
    // A mutable inline parent is never cached, so each page streams the
    // serialization and keeps only the requested window.
    const inline = parentEvidence();
    const ledger = new EvidenceLedger();
    expect(ledger.record(parentEvidence()).ok).toBe(true);
    const text = JSON.stringify(inline);
    const streamed = (offset: number, limit: number | undefined) => {
      const projected = projectEvidenceJsonView(
        {
          evidenceId: inline.evidence_id,
          operation: inline.operation,
          predicateType: inline.predicate_type,
          normalizedResult: inline.normalized_result,
          limitations: inline.limitations,
          evidence: inline,
        } as never,
        {
          kind: "evidence-json",
          offset,
          ...(limit === undefined ? {} : { limit }),
        },
      );
      if (!projected.ok) throw projected.error;
      return projected.value;
    };
    for (const limit of [1, 7, 64, undefined]) {
      let offset = 0;
      let joined = "";
      for (;;) {
        const value = streamed(offset, limit);
        if (limit !== undefined)
          expect(value.text).toBe(
            page(ledger, inline.evidence_id, offset, limit).text,
          );
        joined += value.text;
        if (value.coverage.next_offset === null) break;
        offset = value.coverage.next_offset;
      }
      expect(joined).toBe(text);
    }
  });

  const retainedParent = (
    ledger: EvidenceLedger,
    label: string,
    rows = 120,
  ) => {
    const evidence = createEvidence(
      { path: `/fixture/${label}.bin`, sha256: "d".repeat(64), format: "elf" },
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "inspect_byte_entropy",
        parameters: {},
        result: {
          rows: Array.from({ length: rows }, (_, index) => ({
            index,
            label: `${label} ${String(index)} \u{1F600}`,
          })),
        },
        limitations: [],
      },
    );
    expect(ledger.record(evidence).ok).toBe(true);
    const retained = ledger.forAnalysis(evidence.evidence_id)!;
    return {
      evidenceId: retained.evidence_id,
      operation: retained.operation,
      predicateType: retained.predicate_type,
      normalizedResult: retained.normalized_result,
      limitations: retained.limitations,
      evidence: retained,
    };
  };

  const joinPages = (
    parent: ReturnType<typeof retainedParent>,
    cache: EvidenceJsonSerializationCache,
    limit: number,
  ): string => {
    let offset = 0;
    let joined = "";
    for (;;) {
      const projected = projectEvidenceJsonView(
        parent as never,
        { kind: "evidence-json", offset, limit },
        cache,
      );
      if (!projected.ok) throw projected.error;
      joined += projected.value.text;
      if (projected.value.coverage.next_offset === null) return joined;
      offset = projected.value.coverage.next_offset;
    }
  };

  it("pages a retained record past the cache size from a window without caching it", () => {
    const ledger = new EvidenceLedger();
    // jsonParts yields parts of up to 16 Ki code units; this record spans
    // many, so the window can keep far fewer than the whole record.
    const parent = retainedParent(ledger, "large", 4000);
    const text = JSON.stringify(parent.evidence);
    // The scan collects whole parts until the total passes the cache, then
    // keeps only the window: pages before and after that point must match.
    const cache = new EvidenceJsonSerializationCache(
      Math.floor(text.length / 2),
    );
    for (const limit of [4096, 50_000]) {
      expect(joinPages(parent, cache, limit)).toBe(text);
    }
    expect(cache.holds(parent.evidence)).toBe(false);
    expect(cache.cachedCodeUnits).toBe(0);
    // Past the cache size the scan keeps only parts around the window, not
    // a transient copy of the whole record.
    const page = cache.serialize(parent.evidence as never, 0, 8);
    const kept = page.chunks.reduce((units, chunk) => units + chunk.length, 0);
    expect(page.totalLength).toBe(text.length);
    expect(kept).toBeLessThan(text.length / 2);
  });

  it("evicts the least recently used record to stay within the cache size", () => {
    const ledger = new EvidenceLedger();
    const first = retainedParent(ledger, "rec-a");
    const second = retainedParent(ledger, "rec-b");
    const third = retainedParent(ledger, "rec-c");
    // Equal-length labels give every record the same serialized size.
    const size = JSON.stringify(first.evidence).length;
    expect(JSON.stringify(second.evidence).length).toBe(size);
    const cache = new EvidenceJsonSerializationCache(size * 2 + 64);
    const read = (parent: typeof first) =>
      projectEvidenceJsonView(
        parent as never,
        { kind: "evidence-json", offset: 0, limit: 8 },
        cache,
      );
    read(first);
    read(second);
    expect(cache.holds(first.evidence)).toBe(true);
    expect(cache.holds(second.evidence)).toBe(true);
    // Reading the first again makes the second the least recently used.
    read(first);
    read(third);
    expect(cache.holds(first.evidence)).toBe(true);
    expect(cache.holds(second.evidence)).toBe(false);
    expect(cache.holds(third.evidence)).toBe(true);
    expect(cache.cachedCodeUnits).toBeLessThanOrEqual(cache.maximumCodeUnits);
    // An evicted record still pages exactly from a fresh scan.
    expect(joinPages(second, cache, 97)).toBe(JSON.stringify(second.evidence));
  });

  it("unregisters evicted entries from FinalizationRegistry during repeated churn", () => {
    const ledger = new EvidenceLedger();
    const first = retainedParent(ledger, "churn-a");
    const second = retainedParent(ledger, "churn-b");
    const size = JSON.stringify(first.evidence).length;
    const cache = new EvidenceJsonSerializationCache(size + 64);
    const unregister = vi.spyOn(FinalizationRegistry.prototype, "unregister");
    try {
      for (let round = 0; round < 4; round += 1) {
        projectEvidenceJsonView(
          first as never,
          { kind: "evidence-json", offset: 0, limit: 8 },
          cache,
        );
        projectEvidenceJsonView(
          second as never,
          { kind: "evidence-json", offset: 0, limit: 8 },
          cache,
        );
      }
      // 8 insertions into a 1-record cache trigger 7 evictions, each unregistered.
      expect(unregister).toHaveBeenCalledTimes(7);
      expect(cache.cachedCodeUnits).toBe(size);
    } finally {
      unregister.mockRestore();
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

  it("rejects a starting offset inside a surrogate pair", () => {
    const parent = parentEvidence();
    const ledger = new EvidenceLedger();
    expect(ledger.record(parent).ok).toBe(true);
    const text = JSON.stringify(ledger.forAnalysis(parent.evidence_id));
    const pair = text.indexOf("\u{1F600}");
    const projected = inspectAnalysisViewValidated(
      {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: { kind: "evidence-json", offset: pair + 1, limit: 8 },
      },
      (id) => ledger.forAnalysis(id),
    );
    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(projectAnalysisError(projected.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          expect.objectContaining({
            path: ["view", "offset"],
            reason: "invalid_value",
          }),
        ],
      },
    });
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
