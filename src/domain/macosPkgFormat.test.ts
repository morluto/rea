import { expect, it } from "vitest";

import { hasXarMagic } from "./macosPkgFormat.js";

it("detects xar magic from a prefix", () => {
  expect(hasXarMagic(Buffer.from("xar!more"))).toBe(true);
  expect(hasXarMagic(Buffer.from("PK\u0003\u0004"))).toBe(false);
});
