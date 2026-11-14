import { expect, it } from "vitest";

import { utf8HeadExcerpt } from "./utf8HeadExcerpt.js";

it("keeps text within the budget unchanged", () => {
  expect(utf8HeadExcerpt("abc", 3)).toEqual({
    text: "abc",
    bytes: 3,
    truncated: false,
  });
  expect(utf8HeadExcerpt("", 0)).toEqual({
    text: "",
    bytes: 0,
    truncated: false,
  });
});

it("keeps the start and never splits a character", () => {
  // "é" is 2 bytes, "€" 3 and "😀" 4 (a surrogate pair).
  expect(utf8HeadExcerpt("aé€z", 5)).toEqual({
    text: "aé",
    bytes: 3,
    truncated: true,
  });
  expect(utf8HeadExcerpt("aé€z", 6)).toEqual({
    text: "aé€",
    bytes: 6,
    truncated: true,
  });
  expect(utf8HeadExcerpt("😀x", 3)).toEqual({
    text: "",
    bytes: 0,
    truncated: true,
  });
  expect(utf8HeadExcerpt("😀x", 4)).toEqual({
    text: "😀",
    bytes: 4,
    truncated: true,
  });
});

it("charges a lone surrogate as its 3-byte replacement and keeps the source unit", () => {
  expect(utf8HeadExcerpt("\uD800ab", 4)).toEqual({
    text: "\uD800a",
    bytes: 4,
    truncated: true,
  });
});

it("returns nothing for a non-positive budget", () => {
  expect(utf8HeadExcerpt("abc", 0)).toEqual({
    text: "",
    bytes: 0,
    truncated: true,
  });
  expect(utf8HeadExcerpt("abc", -1)).toEqual({
    text: "",
    bytes: 0,
    truncated: true,
  });
});
