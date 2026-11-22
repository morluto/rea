import { expect, it } from "vitest";

import { byteToHex } from "./byteToHex.js";

it("pads one byte to two lowercase hexadecimal digits", () => {
  expect(byteToHex(0)).toBe("00");
  expect(byteToHex(0x0a)).toBe("0a");
  expect(byteToHex(0xff)).toBe("ff");
});
