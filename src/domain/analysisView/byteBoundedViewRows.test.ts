import { expect, it } from "vitest";

import { ANALYSIS_VIEW_PAGE_BYTES } from "./analysisViewErrors.js";
import { selectByteBoundedViewRows } from "./byteBoundedViewRows.js";

const owner = {
  parentEvidenceId: `ev_${"a".repeat(64)}`,
  envelope: { kind: "probe" },
  facet: "rows",
};

it("projects only the page's rows when unfiltered", () => {
  const projected: number[] = [];
  const page = selectByteBoundedViewRows(
    Array.from({ length: 1_000 }, (_, index) => index),
    { offset: 10, limit: 3 },
    {
      matches: undefined,
      project: (row) => {
        projected.push(row);
        return { row };
      },
    },
    owner,
  );
  expect(page).toEqual({
    ok: true,
    value: {
      rows: [{ row: 10 }, { row: 11 }, { row: 12 }],
      total: 1_000,
      byte_limited: false,
    },
  });
  expect(projected).toEqual([10, 11, 12]);
});

it("counts every match after a byte-limited page", () => {
  const big = "x".repeat(ANALYSIS_VIEW_PAGE_BYTES / 3);
  const page = selectByteBoundedViewRows(
    Array.from({ length: 8 }, (_, index) => ({ index, big })),
    { offset: 0, limit: 64 },
    { matches: (row) => row.index % 2 === 0, project: (row) => row },
    owner,
  );
  if (!page.ok) throw page.error;
  expect(page.value.rows.map((row) => row.index)).toEqual([0, 2]);
  expect(page.value).toMatchObject({ total: 4, byte_limited: true });
});

it("refuses a row that cannot fit a page alone and names the parent", () => {
  const page = selectByteBoundedViewRows(
    ["x".repeat(ANALYSIS_VIEW_PAGE_BYTES)],
    { offset: 0, limit: 1 },
    { matches: undefined, project: (row) => row },
    owner,
  );
  expect(page).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: {
        parent_evidence_id: owner.parentEvidenceId,
        facet: "rows",
        limit_bytes: ANALYSIS_VIEW_PAGE_BYTES,
      },
    },
  });
});
