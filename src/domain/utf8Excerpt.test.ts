import { expect, it } from "vitest";

import { utf8TailExcerpt } from "./utf8Excerpt.js";

it("keeps text within the budget unchanged", () => {
  expect(utf8TailExcerpt("abc", 3)).toEqual({
    text: "abc",
    bytes: 3,
    truncated: false,
  });
});

it("keeps the end and never splits a character", () => {
  // "é" is 2 bytes and "€" is 3; a 4-byte budget would cut "€" in half.
  expect(utf8TailExcerpt("aé€z", 5)).toEqual({
    text: "€z",
    bytes: 4,
    truncated: true,
  });
  expect(utf8TailExcerpt("aé€z", 6)).toEqual({
    text: "é€z",
    bytes: 6,
    truncated: true,
  });
});

it("returns nothing when no whole character fits", () => {
  expect(utf8TailExcerpt("€", 2)).toEqual({
    text: "",
    bytes: 0,
    truncated: true,
  });
});
