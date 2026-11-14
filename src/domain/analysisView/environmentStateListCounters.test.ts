import { expect, it } from "vitest";
import type { JsonValue } from "../jsonValue.js";
import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";
import { renderQueryList } from "./environmentStateListQuery.js";
import {
  recordedItemCount,
  renderStateList,
  type JsonObject,
} from "./environmentStateRules.js";

const vessel = (id: number, status: string): JsonObject => ({
  Id: id,
  name: `Vessel ${String(id)}`,
  status,
});
const SEEDED = [vessel(1, "Active"), vessel(2, "In Port"), vessel(3, "Active")];

/** A list in a paging envelope that counts its rows beside two page flags. */
const page = (list: readonly JsonObject[], totalRows = list.length) => ({
  list: [...list],
  pageInfo: {
    totalRows,
    page: 1,
    pageSize: 25,
    isFirstPage: true,
    isLastPage: true,
  },
});

/** A list beside a top-level total whose member name starts with a slash. */
const slashed = (list: readonly JsonObject[]) => ({
  list: [...list],
  "/total_count": list.length,
});

/** Seeded reads, a filtered line, then a create its list read-back counts, each list in `envelope`. */
const rowsOf = (
  envelope: (list: readonly JsonObject[]) => JsonValue = page,
): TimedCaptureRow[] => [
  ["GET", "/api/records?limit=25", envelope(SEEDED)],
  ["GET", "/api/records/1", SEEDED[0]!],
  ["GET", "/api/records/2", SEEDED[1]!],
  ["GET", "/api/records/3", SEEDED[2]!],
  [
    "GET",
    "/api/records?where=(status,eq,Active)",
    envelope([SEEDED[0]!, SEEDED[2]!]),
  ],
  [
    "POST",
    "/api/records",
    { Id: 4 },
    200,
    { name: "Vessel 4", status: "Laid Up" },
  ],
  ["GET", "/api/records/4", vessel(4, "Laid Up")],
  ["GET", "/api/records?limit=25", envelope([...SEEDED, vessel(4, "Laid Up")])],
];
const rows = rowsOf();

it("counts a total nested in a paging object, and serves the create its list read-back counts", () => {
  const state = environmentStateViewOf(timedCaptureEvidence(rows));
  expect(state.views.find((view) => view.tool === "get_records")).toMatchObject(
    { shape: "list", counters: ["/pageInfo/totalRows"] },
  );
  expect(
    state.writes.find((write) => write.tool === "post_records"),
  ).toMatchObject({ served: true, reason: null });
});

it("names a top-level total whose name starts with a slash by its pointer, and serves the create its list read-back counts", () => {
  const state = environmentStateViewOf(timedCaptureEvidence(rowsOf(slashed)));
  expect(state.views.find((view) => view.tool === "get_records")).toMatchObject(
    { shape: "list", counters: ["/~1total_count"] },
  );
  expect(
    state.writes.find((write) => write.tool === "post_records"),
  ).toMatchObject({ served: true, reason: null });
});

it("renders a nested counter and a nested query total from the state, leaving the page flags as recorded", () => {
  const base = page(SEEDED);
  const items = [...SEEDED, vessel(4, "Laid Up")];
  const view = {
    pointer: "/list",
    counters: ["/pageInfo/totalRows"],
    query: { totals: ["/pageInfo/totalRows"] },
  };
  expect(renderStateList(view, base, items)).toEqual(page(items));
  expect(renderQueryList(view, page([SEEDED[0]!]), [SEEDED[0]!], 2)).toEqual(
    page([SEEDED[0]!], 2),
  );
});

it("takes no nested member for a counter unless it equals the number listed", () => {
  const offBy = rows.map((row): TimedCaptureRow =>
    row[1] === "/api/records?limit=25" && row[2] !== undefined
      ? [row[0], row[1], { ...(row[2] as JsonObject), meta: { total: 99 } }]
      : row,
  );
  const state = environmentStateViewOf(timedCaptureEvidence(offBy));
  // The mismatched member is excluded while the recorded list keeps its valid counter.
  expect(state.views.find((view) => view.tool === "get_records")).toMatchObject(
    {
      shape: "list",
      membership: "recorded",
      counters: ["/pageInfo/totalRows"],
    },
  );
});

it.each([{ nextCursor: "cursor-2" }, { has_more: true }, { nextPage: 2 }])(
  "keeps membership recorded when paging metadata says more items follow: %j",
  (pageInfo) => {
    const state = environmentStateViewOf(
      timedCaptureEvidence([
        ["GET", "/api/records", { list: SEEDED, pageInfo }],
        ...SEEDED.map((item): TimedCaptureRow => [
          "GET",
          `/api/records/${String(item["Id"])}`,
          item,
        ]),
      ]),
    );
    expect(
      state.views.find((view) => view.tool === "get_records"),
    ).toMatchObject({
      shape: "list",
      membership: "recorded",
    });
  },
);

it("keeps completed paging envelopes whole and does not read entity fields as continuation metadata", () => {
  const items = SEEDED.map((item): JsonObject => ({
    ...item,
    nextCursor: "entity-value",
  }));
  const state = environmentStateViewOf(
    timedCaptureEvidence([
      [
        "GET",
        "/api/records",
        { list: items, pageInfo: { nextCursor: null, has_more: false } },
      ],
      ...items.map((item): TimedCaptureRow => [
        "GET",
        `/api/records/${String(item["Id"])}`,
        item,
      ]),
    ]),
  );
  expect(state.views.find((view) => view.tool === "get_records")).toMatchObject(
    {
      shape: "list",
      membership: "all",
    },
  );
});

it("keeps a direction-only recording on its recorded members instead of learning an unused direction", () => {
  const state = environmentStateViewOf(
    timedCaptureEvidence([
      ["GET", "/api/records", SEEDED],
      ["GET", "/api/records?direction=desc", SEEDED],
      ...SEEDED.map((item): TimedCaptureRow => [
        "GET",
        `/api/records/${String(item["Id"])}`,
        item,
      ]),
    ]),
  );
  const view = state.views.find(
    (candidate) => candidate.tool === "get_records",
  );
  expect(view).toMatchObject({
    shape: "list",
    membership: "recorded",
    checked_record_ordinals: [0, 1],
  });
  expect(view).not.toHaveProperty("query.parameters.direction");
});

it("admits non-negative safe integers and rejects fractional, negative or unsafe values in recorded item counts", () => {
  for (const valid of [
    0,
    1,
    42,
    Number.MAX_SAFE_INTEGER,
    "0",
    "1",
    "42",
    String(Number.MAX_SAFE_INTEGER),
  ])
    expect(recordedItemCount(valid), String(valid)).toBe(Number(valid));

  for (const invalid of [
    -1,
    -42,
    1.5,
    Number.NaN,
    Infinity,
    -Infinity,
    "-1",
    "1.5",
    "9007199254740992",
    "999999999999999999999999",
    null,
    undefined,
    [],
    {},
    "abc",
  ])
    expect(
      recordedItemCount(invalid as JsonValue),
      String(invalid),
    ).toBeUndefined();
});
