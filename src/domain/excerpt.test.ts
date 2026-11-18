import { expect, expectTypeOf, it } from "vitest";

import type { compactStringIdentityKey } from "./compactStringIdentity.js";
import { ellipsisExcerpt, quotedExcerpt } from "./excerpt.js";
import type { utf8TailExcerpt } from "./utf8Excerpt.js";
import type { utf8HeadExcerpt } from "./utf8HeadExcerpt.js";

type HeadText = ReturnType<typeof utf8HeadExcerpt>["text"];
type TailText = ReturnType<typeof utf8TailExcerpt>["text"];
expectTypeOf<HeadText>().toExtend<string>();
expectTypeOf<TailText>().toExtend<string>();
expectTypeOf<
  Parameters<typeof compactStringIdentityKey<HeadText>>[0]
>().toBeNever();
expectTypeOf<
  Parameters<typeof compactStringIdentityKey<TailText>>[0]
>().toBeNever();
expectTypeOf<
  Parameters<typeof compactStringIdentityKey<string>>[0]
>().toEqualTypeOf<string>();

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
