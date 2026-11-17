import { expect, it } from "vitest";

import { decodeZipCp437 } from "./zipEntryText.js";

it("decodes legacy ZIP names as ASCII below 0x80 and Unicode CP437 above", () => {
  // macOS folder icon file: the trailing CR stays a control character.
  expect(decodeZipCp437(Uint8Array.of(0x49, 0x63, 0x6f, 0x6e, 0x0d))).toBe(
    "Icon\r",
  );
  expect(decodeZipCp437(Uint8Array.of(0x80, 0x9e, 0xe1, 0xff))).toBe(
    `Ç₧ß${String.fromCharCode(0xa0)}`,
  );
});
