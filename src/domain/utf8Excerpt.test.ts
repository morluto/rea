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

it("keeps the bounded suffix of a long stream with supplementary characters", () => {
  const stream = "prefix".repeat(100_000) + "a𐐷éz";
  expect(utf8TailExcerpt(stream, 7)).toEqual({
    text: "𐐷éz",
    bytes: 7,
    truncated: true,
  });
  expect(utf8TailExcerpt(stream, 6)).toEqual({
    text: "éz",
    bytes: 3,
    truncated: true,
  });
});

it("preserves the encoding behavior of unpaired surrogates", () => {
  expect(utf8TailExcerpt("\ud800", 3).text).toBe("\ud800");
  expect(utf8TailExcerpt("prefix\ud800", 3).text).toBe("\ufffd");
});
