import { expect, it } from "vitest";

import {
  decodeStrictUtf8,
  isStrictUtf8,
  strictUtf8Decoder,
} from "./strictUtf8.js";

const bomPrefixed = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d);

it("keeps a leading BOM unless the caller states it is a signature", () => {
  expect(decodeStrictUtf8(bomPrefixed, "preserve")).toBe("﻿{}");
  expect(decodeStrictUtf8(bomPrefixed, "strip-signature")).toBe("{}");
  expect(strictUtf8Decoder("preserve").decode(bomPrefixed)).toBe("﻿{}");
});

it("refuses malformed UTF-8 for every policy", () => {
  const malformed = Uint8Array.of(0x61, 0xc3);
  expect(() => decodeStrictUtf8(malformed, "preserve")).toThrow(TypeError);
  expect(() => decodeStrictUtf8(malformed, "strip-signature")).toThrow(
    TypeError,
  );
  expect(isStrictUtf8(malformed)).toBe(false);
  expect(isStrictUtf8(bomPrefixed)).toBe(true);
});
