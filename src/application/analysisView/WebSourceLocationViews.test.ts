import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { expect, it } from "vitest";
import {
  webSourceLocationArgs,
  webSourceLocationFixture,
  webSourceMapDecoderFixture,
} from "../../../tests/fixtures/webSourceLocation.js";
import { WebSourceLocationService } from "../WebSourceLocationService.js";
import { ok } from "../../domain/result.js";
import {
  inspectAnalysisView,
  projectRetainedAnalysis,
} from "./AnalysisViewService.js";
import { analysisViewRequestSchema } from "../../domain/analysisView/analysisViewRequest.js";
import type { Evidence } from "../../domain/evidence.js";

const trace = async (
  mappings = "AAAA,ACAA,A",
  sourcesContent: (string | null)[] = ["a😀b", null],
) => {
  const fixture = webSourceLocationFixture(
    JSON.stringify({
      version: 3,
      sources: ["one.ts", "one.ts"],
      sourcesContent,
      names: [],
      mappings,
    }),
  );
  const service = new WebSourceLocationService(
    { load: async () => ok(fixture) },
    webSourceMapDecoderFixture,
  );
  const result = await service.trace(webSourceLocationArgs);
  if (!result.ok) throw result.error;
  return result.value;
};
const viewOf = (evidence: Evidence, view: unknown) =>
  inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
      view,
    },
    (id) => (id === evidence.evidence_id ? evidence : undefined),
  );

const readView = async (parent: Evidence, view: unknown) => {
  const result = await viewOf(parent, view);
  if (!result.ok) throw result.error;
  return result.value.normalized_result;
};

it("keeps all alternatives in summary and continues a byte-limited match page", async () => {
  const parent = await trace();
  const summary = await viewOf(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value.normalized_result).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    summary: {
      match_count: 3,
      matches: [
        {
          match_index: 0,
          source_index: 0,
          reported_source: "one.ts",
          content: { state: "embedded", code_units: 4 },
        },
        {
          match_index: 1,
          source_index: 1,
          reported_source: "one.ts",
          content: { state: "unavailable" },
        },
        { match_index: 2, state: "generated-only" },
      ],
    },
    coverage: { total: 3, examined: 3, exhausted: true },
  });
  expect(JSON.stringify(summary.value)).not.toContain('"text":');
  const view = { kind: "source-location", collection: "matches" };
  const refused = await viewOf(parent, { ...view, max_bytes: 1 });
  expect(refused).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: { max_bytes: 1 },
      remediationAction: expect.stringContaining("view.max_bytes"),
    },
  });
  const single = await readView(parent, { ...view, limit: 1 });
  // Leave room for the coverage fields while keeping the second row over budget.
  const maxBytes = Buffer.byteLength(JSON.stringify(single)) + 64;
  const first = await readView(parent, { ...view, max_bytes: maxBytes });
  expect(first).toMatchObject({
    items: [{ match_index: 0, source_index: 0 }],
    coverage: { total: 3, examined: 1, next_offset: 1, exhausted: false },
  });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
    maxBytes,
  );
  expect(await readView(parent, { ...view, offset: 1 })).toMatchObject({
    items: [
      { match_index: 1, source_index: 1 },
      { match_index: 2, state: "generated-only" },
    ],
    coverage: { total: 3, examined: 2, exhausted: true },
  });
});

it("reports an empty lookup without inventing a mapping", async () => {
  expect(await readView(await trace(""), { kind: "summary" })).toMatchObject({
    summary: { match_count: 0, matches: [] },
    coverage: { status: "empty", total: 0, examined: 0, exhausted: true },
  });
});

it("selects exact UTF-16 content pages and preserves unavailable content", async () => {
  const parent = await trace();
  const view = {
    kind: "source-location",
    collection: "source-text",
    match_index: 0,
    offset: 1,
    limit: 2,
  };
  expect(await readView(parent, view)).toMatchObject({
    match: { match_index: 0, content: { code_units: 4 } },
    item: { text: "😀", unit: "utf16-code-units" },
    coverage: { total: 4, examined: 2, next_offset: 3 },
  });
  expect((await viewOf(parent, { ...view, offset: 2 })).ok).toBe(false);
  expect((await viewOf(parent, { ...view, limit: 1 })).ok).toBe(false);
  expect(await readView(parent, { ...view, match_index: 1 })).toMatchObject({
    item: null,
    match: { content: { state: "unavailable" } },
    coverage: { status: "unavailable", total: null, exhausted: false },
  });
  expect(await viewOf(parent, { ...view, match_index: 3 })).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [{ path: ["view", "match_index"] }],
    },
  });
});

it("preserves already retained parent recovery when a selected projection fails", async () => {
  const expected = "\u0001".repeat(1_000);
  const parent = await trace("AAAA", [expected, null]);
  const records = new EvidenceLedger();
  const retention = {
    recordEvidence: (evidence: Evidence) => records.record(evidence),
    evidenceById: (id: string) => records.forAnalysis(id),
  };
  const view = {
    kind: "source-location",
    collection: "source-text",
    match_index: 0,
    limit: expected.length,
  };
  const escapedBudget = 5_000;
  expect(expected.length).toBeLessThan(escapedBudget);
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(
    escapedBudget,
  );
  for (const max_bytes of [500, escapedBudget]) {
    const refused = projectRetainedAnalysis(
      parent,
      retention,
      analysisViewRequestSchema.parse({ ...view, max_bytes }),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        partialObservation: {
          kind: "retained-evidence",
          evidence_id: parent.evidence_id,
        },
      },
    });
  }
  const retained = records.forAnalysis(parent.evidence_id);
  if (retained === undefined) throw new Error("Expected retained parent");
  const output = (await readView(retained, { ...view, max_bytes: 20000 })) as {
    item: { text: string };
  };
  expect(output.item.text).toBe(expected);
});
