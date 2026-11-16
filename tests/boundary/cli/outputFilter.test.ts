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
