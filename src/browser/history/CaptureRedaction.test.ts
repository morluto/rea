import { expect, it } from "vitest";
import { CaptureRedaction } from "./CaptureRedaction.js";

it.each([
  {
    value: " https://user:password@example.test/path ",
    expected: " https://example.test/path ",
  },
  {
    value: "\tHTTPS://user:password@example.test/path\t",
    expected: "\tHTTPS://example.test/path\t",
  },
  {
    value: " \t//user:password@example.test/path?token=ordinary#fragment\t ",
    expected: " \t//example.test/path?token=ordinary#fragment\t ",
  },
])(
  "excludes URL userinfo after optional whitespace while preserving the original header text: $value",
  ({ value, expected }) => {
    const redactor = new CaptureRedaction([]);
    expect(redactor.text(value, "/response/headers/0/value", true)).toBe(
      expected,
    );
    expect(redactor.redactions).toEqual([
      { pointer: "/response/headers/0/value", reason: "transport-credential" },
    ]);
  },
);

it("preserves the same URL-looking text in an ordinary extension", () => {
  const redactor = new CaptureRedaction([]);
  const value = " \thttps://user:password@example.test/path\t ";
  expect(redactor.text(value, "/_extension")).toBe(value);
  expect(redactor.redactions).toEqual([]);
});

it.each(["\ud800", "\udfff"])(
  "does not invent replacement UTF-8 bytes for a non-scalar declaration",
  (literal) => {
    const redactor = new CaptureRedaction([literal]);
    expect(redactor.sensitiveBytes(Buffer.from("\ufffd"))).toBe(false);
    expect(redactor.text(literal, "/reported")).toBe(null);
  },
);

it("matches scalar UTF-8 declarations and complete surrogate pairs exactly", () => {
  expect(
    new CaptureRedaction(["\ufffd"]).sensitiveBytes(Buffer.from("\ufffd")),
  ).toBe(true);
  expect(
    new CaptureRedaction(["\ud83d\ude00"]).sensitiveBytes(Buffer.from("😀")),
  ).toBe(true);
});
