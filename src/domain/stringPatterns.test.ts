import { expect, it } from "vitest";

import {
  CANONICAL_BASE64_PATTERN,
  IDENTIFIER_PATTERN,
  STABLE_IDENTIFIER_PATTERN,
} from "./stringPatterns.js";

it("preserves identifier grammars under Unicode and Unicode-set compilation", () => {
  const variants = [
    { pattern: IDENTIFIER_PATTERN, previous: /^[A-Za-z][A-Za-z0-9._-]*$/u },
    {
      pattern: STABLE_IDENTIFIER_PATTERN,
      previous: /^[A-Za-z][A-Za-z0-9._:/-]*$/u,
    },
  ];
  const samples = [
    "",
    "a",
    "A",
    "_id",
    "1id",
    "é",
    "aé",
    "a/b:c",
    "a-b.c_1",
    "a\n",
    "a\\b",
  ];
  for (let code = 0; code < 128; code += 1) {
    const character = String.fromCharCode(code);
    samples.push(character, `A${character}`, `A${character}B`);
  }
  for (const { pattern, previous } of variants) {
    for (const flag of ["u", "v"]) {
      const projected = new RegExp(pattern.source, flag);
      for (const sample of samples)
        expect(projected.test(sample), JSON.stringify({ flag, sample })).toBe(
          previous.test(sample),
        );
    }
  }
});

it("preserves canonical base64 padding and pad-bit validation", () => {
  const previous =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
  const samples = [
    "",
    "AA==",
    "AB==",
    "AAA=",
    "AAB=",
    "////",
    "A",
    "AA",
    "AAA",
    "====",
    "AA==\n",
    "AA-_",
    "a b c",
  ];
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const first of alphabet)
    for (const second of alphabet)
      samples.push(`${first}${second}==`, `A${first}${second}=`);
  for (const flag of ["u", "v"]) {
    const projected = new RegExp(CANONICAL_BASE64_PATTERN.source, flag);
    for (const sample of samples)
      expect(projected.test(sample), JSON.stringify({ flag, sample })).toBe(
        previous.test(sample),
      );
  }
});
