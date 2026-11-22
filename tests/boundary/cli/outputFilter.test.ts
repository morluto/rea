import { expect, it } from "vitest";

import { parseOutputFilter } from "../../../src/cli/outputFilter.js";

it.each([
  ["a", [[{ key: "a" }]]],
  ["a.b,c", [[{ key: "a" }, { key: "b" }], [{ key: "c" }]]],
  [
    "rows[0,3].name",
    [[{ key: "rows" }, { start: 0, end: 3 }, { key: "name" }]],
  ],
  ["a[1,2],b", [[{ key: "a" }, { start: 1, end: 2 }], [{ key: "b" }]]],
  ["a[,2]", [[{ key: "a" }, { start: 0, end: 2 }]]],
  ["a[-1,]", [[{ key: "a" }, { start: -1, end: 0 }]]],
  ["a[1]", [[{ key: "a" }, { start: 1, end: NaN }]]],
  ["a[[0,1]", [[{ key: "a" }, { start: NaN, end: 1 }]]],
  ["a..b.", [[{ key: "a" }, { key: "b" }]]],
  ["a,,b,", [[{ key: "a" }], [], [{ key: "b" }]]],
])("parses %j", (expression, paths) => {
  expect(parseOutputFilter(expression)).toEqual({ ok: true, value: paths });
});

it.each(["a[0", "a[0,1", "a[0],b[", "]a,[0"])(
  "refuses the unclosed slice in %j",
  (expression) => {
    expect(parseOutputFilter(expression)).toEqual({
      ok: false,
      error: { kind: "unclosed_slice" },
    });
  },
);

it.each(["rows[0,1,2].name", "name,rows[-1,2,]"])(
  "refuses surplus slice bounds in %j",
  (expression) => {
    expect(parseOutputFilter(expression)).toEqual({
      ok: false,
      error: { kind: "extra_slice_bounds" },
    });
  },
);

it.each([
  "rows[x,2]",
  "rows[0,2x]",
  "rows[x]",
  "rows[[x,1]",
  "rows[[x]",
  "rows[0,2][invalid,1]",
])("refuses a nonnumeric slice bound in %j", (expression) => {
  expect(parseOutputFilter(expression)).toEqual({
    ok: false,
    error: { kind: "invalid_slice_bound" },
  });
});
