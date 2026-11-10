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
import { analysisViewRequestSchema } from "../../domain/analysisView/analysisView.js";
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

it("keeps every equal-position alternative and original indices without embedded text", async () => {
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
  const page = await viewOf(parent, {
    kind: "source-location",
    collection: "matches",
    offset: 1,
    limit: 1,
  });
  if (!page.ok) throw page.error;
  expect(page.value.normalized_result).toMatchObject({
    items: [{ match_index: 1, source_index: 1 }],
    coverage: { total: 3, examined: 1, next_offset: 2, exhausted: false },
  });
});

it("reports an empty lookup without inventing a mapping", async () => {
  const summary = await viewOf(await trace(""), { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value.normalized_result).toMatchObject({
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
  const text = await viewOf(parent, view);
  if (!text.ok) throw text.error;
  expect(text.value.normalized_result).toMatchObject({
    match: { match_index: 0, content: { code_units: 4 } },
    item: { text: "😀", unit: "utf16-code-units" },
    coverage: { total: 4, examined: 2, next_offset: 3 },
  });
  expect((await viewOf(parent, { ...view, offset: 2 })).ok).toBe(false);
  expect((await viewOf(parent, { ...view, limit: 1 })).ok).toBe(false);
  const unavailable = await viewOf(parent, { ...view, match_index: 1 });
  if (!unavailable.ok) throw unavailable.error;
  expect(unavailable.value.normalized_result).toMatchObject({
    item: null,
    match: { content: { state: "unavailable" } },
    coverage: { status: "unavailable", total: null, exhausted: false },
  });
});

it("returns recoverable byte admission and rejects invalid indices", async () => {
  const parent = await trace();
  const selected = {
    kind: "source-location",
    collection: "matches",
    max_bytes: 1,
  };
  const refused = await viewOf(parent, selected);
  if (refused.ok) throw new Error("expected view byte refusal");
  expect(refused.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    reportedLimits: { max_bytes: 1 },
    remediationAction: expect.stringContaining("view.max_bytes"),
  });
  expect((await viewOf(parent, { ...selected, max_bytes: 65536 })).ok).toBe(
    true,
  );
  expect(
    (
      await viewOf(parent, {
        kind: "source-location",
        collection: "source-text",
        match_index: 3,
      })
    ).ok,
  ).toBe(false);
});

it("preserves already retained parent recovery when a selected projection fails", async () => {
  const parent = await trace("AAAA", ["a".repeat(10000), null]);
  const records = new EvidenceLedger();
  const retention = {
    recordEvidence: (evidence: Evidence) => records.record(evidence),
    evidenceById: (id: string) => records.forAnalysis(id),
  };
  const view = {
    kind: "source-location",
    collection: "source-text",
    match_index: 0,
    limit: 10000,
    max_bytes: 2000,
  };
  const refused = projectRetainedAnalysis(
    parent,
    retention,
    analysisViewRequestSchema.parse(view),
  );
  if (refused.ok) throw new Error("expected projection admission failure");
  expect(refused.error.partialObservation).toEqual({
    kind: "retained-evidence",
    evidence_id: parent.evidence_id,
  });
  expect(records.forAnalysis(parent.evidence_id)?.evidence_id).toBe(
    parent.evidence_id,
  );
  const recovered = await viewOf(parent, { ...view, max_bytes: 20000 });
  if (!recovered.ok) throw recovered.error;
  const output = recovered.value.normalized_result as {
    item: { text: string };
  };
  expect(output.item.text.length).toBe(10000);
});
