import { expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  FIRST_BOOK,
  environmentStateViewOf,
} from "../../../tests/fixtures/environmentStateWrites.js";

it.each([
  { fraction: "123456790", served: true, label: "one nanosecond later" },
  { fraction: "123456788", served: false, label: "one nanosecond earlier" },
  { fraction: "123456789", served: false, label: "the same instant" },
  { fraction: "124456789", served: true, label: "one millisecond later" },
])("checks an update clock at $label", ({ fraction, served }) => {
  const first = {
    ...FIRST_BOOK,
    name: "Second title",
    updated_at: "2026-10-17T18:00:03.123456789Z",
  };
  const second = {
    ...first,
    name: "Third title",
    updated_at: `2026-10-17T18:00:03.${fraction}Z`,
  };
  const state = environmentStateViewOf(
    timedCaptureEvidence([
      ["GET", "/api/books", [FIRST_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["PATCH", "/api/books/1", first, 200, { name: first.name }],
      ["GET", "/api/books/1", first],
      ["PATCH", "/api/books/1", second, 200, { name: second.name }],
      ["GET", "/api/books/1", second],
    ]),
  );
  expect(
    state.writes.find((plan) => plan.tool === "patch_books_by_id"),
  ).toMatchObject({
    served,
    reason: served ? null : "unexplained-change",
    checked_record_ordinals: served ? [3, 5] : [3],
    rules: expect.arrayContaining([
      {
        field: "updated_at",
        rule: "clock",
        format: { kind: "iso", separator: "T", fraction: 9, zone: "Z" },
      },
    ]),
  });
});

it.each([false, true])(
  "learns only after an unknown entity is observed again (update while unknown: %s)",
  (updateWhileUnknown) => {
    const initial = { ...FIRST_BOOK, revision: 1 };
    const observed = { ...initial, name: "Second title", revision: 2 };
    const final = { ...observed, name: "Third title" };
    const unknownCall: TimedCaptureRow[] = updateWhileUnknown
      ? [["PATCH", "/api/books/1", observed, 200, { name: observed.name }]]
      : [];
    const state = environmentStateViewOf(
      timedCaptureEvidence([
        ["GET", "/api/books", [initial]],
        ["GET", "/api/books/1", initial],
        ["POST", "/api/books/1/import", { queued: true }, 302, {}],
        ...unknownCall,
        ["GET", "/api/books/1", observed],
        ["PATCH", "/api/books/1", final, 200, { name: final.name }],
        ["GET", "/api/books/1", final],
      ]),
    );
    expect(
      state.writes.find((plan) => plan.tool === "patch_books_by_id"),
    ).toMatchObject({
      served: true,
      reason: null,
      exemplar_ordinal: updateWhileUnknown ? 5 : 4,
      checked_record_ordinals: [updateWhileUnknown ? 6 : 5],
      rules: [{ field: "name", rule: "echo" }],
    });
  },
);

it.each([
  { requestId: 1, ambiguous: false, served: true },
  { requestId: 2, ambiguous: false, served: true },
  { requestId: 1, ambiguous: true, served: false },
])(
  "uses the known identity field for response observation ($requestId, ambiguous: $ambiguous)",
  ({ requestId, ambiguous, served }) => {
    const changed = { ...FIRST_BOOK, name: "Second title" };
    const response = {
      request_id: requestId,
      data: changed,
      ...(ambiguous ? { other: changed } : {}),
    };
    const state = environmentStateViewOf(
      timedCaptureEvidence([
        ["GET", "/api/books", [FIRST_BOOK]],
        ["GET", "/api/books/1", FIRST_BOOK],
        ["PATCH", "/api/books/1", response, 200, { name: changed.name }],
        ["GET", "/api/books/1", changed],
      ]),
    );
    const plan = state.writes.find(
      (candidate) => candidate.tool === "patch_books_by_id",
    );
    expect(plan?.served).toBe(served);
    if (served)
      expect(plan).toMatchObject({
        observation: { ordinal: 2, pointer: "/data" },
        response: { ordinal: 2, shape: "entity", pointer: "/data" },
        checked_record_ordinals: [3],
      });
  },
);
