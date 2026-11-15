import { expect, it } from "vitest";

import { compactStringIdentityKey } from "./compactStringIdentity.js";
import { ellipsisExcerpt, quotedExcerpt } from "./excerpt.js";
import { utf8TailExcerpt } from "./utf8Excerpt.js";
import { utf8HeadExcerpt } from "./utf8HeadExcerpt.js";

it("refuses excerpt text where an identity is expected, at compile time", () => {
  const source = "module/path/entry";
  const head = utf8HeadExcerpt(source, 6);
  const tail = utf8TailExcerpt(source, 6);
  expect(head).toMatchObject({ text: "module", truncated: true });
  expect(tail).toMatchObject({ text: "/entry", truncated: true });
  expect(compactStringIdentityKey(source)).toBe(source);
  // @ts-expect-error A head excerpt is display text, not the source value.
  compactStringIdentityKey(head.text);
  // @ts-expect-error A tail excerpt is display text, not the source value.
  compactStringIdentityKey(tail.text);
  // Displaying an excerpt is still ordinary string use.
  expect(`${head.text}…`).toBe("module…");
});

it("cuts display text with an ellipsis without splitting a surrogate pair", () => {
  expect(ellipsisExcerpt("short", 5)).toBe("short");
  expect(ellipsisExcerpt("longer text", 6)).toBe("longer…");
  // "a😀b": the pair occupies code units 1 and 2; a cut after unit 2 would
  // keep only its high surrogate.
  expect(ellipsisExcerpt("a\u{1F600}b", 2)).toBe("a…");
  expect(ellipsisExcerpt("a\u{1F600}b", 3)).toBe("a\u{1F600}…");
  expect(ellipsisExcerpt("abc", 0)).toBe("…");
});

it("quotes a diagnostic value with its full length when cut", () => {
  expect(quotedExcerpt('a"b', 3)).toBe('"a\\"b"');
  expect(quotedExcerpt("abcdef", 3)).toBe('"abc"… (6 UTF-16 code units)');
  // A cut inside a surrogate pair would quote a lone high surrogate as \ud83d.
  expect(quotedExcerpt("a\u{1F600}b", 2)).toBe('"a"… (4 UTF-16 code units)');
});
