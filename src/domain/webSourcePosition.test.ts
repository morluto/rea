import { expect, it } from "vitest";
import {
  resolveWebSourcePosition,
  webSourceOffset,
} from "./webSourcePosition.js";

it("uses UTF-16 columns and actual JavaScript line terminators", () => {
  const text = "🎋a\r\nb\rc\nd\u2028e\u2029";
  expect(webSourceOffset(text, { line: 1, column: 2 })).toBe(2);
  expect(webSourceOffset(text, { line: 1, column: 3 })).toBe(3);
  expect(webSourceOffset(text, { line: 1, column: 4 })).toBeUndefined();
  expect(webSourceOffset(text, { line: 2, column: 0 })).toBe(5);
  expect(webSourceOffset(text, { line: 6, column: 0 })).toBe(13);
  expect(webSourceOffset(text, { line: 7, column: 0 })).toBeUndefined();
});

it.each([
  { line: 0, column: 0 },
  { line: 1, column: -1 },
  { line: 1.5, column: 0 },
])("rejects invalid source positions: %j", (position) => {
  expect(webSourceOffset("", position)).toBeUndefined();
});

it("retains the empty source and the final empty line", () => {
  expect(webSourceOffset("", { line: 1, column: 0 })).toBe(0);
  expect(webSourceOffset("a\r\n", { line: 2, column: 0 })).toBe(3);
});

it.each([
  { text: "", position: { line: 1, column: 0 }, expected: { offset: 0 } },
  {
    text: "",
    position: { line: 1, column: 1 },
    expected: { field: "column", maximum: 0 },
  },
  {
    text: "",
    position: { line: 2, column: 0 },
    expected: { field: "line", maximum: 1 },
  },
  {
    text: "a\r\n",
    position: { line: 3, column: 0 },
    expected: { field: "line", maximum: 2 },
  },
  {
    text: "ab\rc",
    position: { line: 1, column: 3 },
    expected: { field: "column", maximum: 2 },
  },
  {
    text: "a\u2028bc\u2029",
    position: { line: 2, column: 3 },
    expected: { field: "column", maximum: 2 },
  },
  {
    text: "a\u2028bc\u2029",
    position: { line: 4, column: 0 },
    expected: { field: "line", maximum: 3 },
  },
  {
    text: "🎋\n",
    position: { line: 1, column: 3 },
    expected: { field: "column", maximum: 2 },
  },
])(
  "names the coordinate past the end of the text: %j",
  ({ text, position, expected }) => {
    expect(resolveWebSourcePosition(text, position)).toEqual(expected);
  },
);

it.each([
  { line: 0, column: 0 },
  { line: 1, column: -1 },
  { line: 1.5, column: 0 },
])("reports no limit for invalid source positions: %j", (position) => {
  expect(resolveWebSourcePosition("a\nb", position)).toBeUndefined();
});
