import { describe, expect, it } from "vitest";

import { matchErc1167Clone } from "./evmProxy.js";

const PREFIX = "363d3d373d3d3d363d73";
const SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const ADDRESS = "bebebebebebebebebebebebebebebebebebebebe";
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

describe("ERC-1167 clone recognition", () => {
  it("reports the embedded address with its byte range", () => {
    expect(matchErc1167Clone(bytes(PREFIX + ADDRESS + SUFFIX))).toEqual({
      kind: "erc1167",
      implementation: `0x${ADDRESS}`,
      implementation_byte_range: { start: 10, end: 30 },
    });
  });

  it.each([
    ["a changed prefix", `37${PREFIX.slice(2)}${ADDRESS}${SUFFIX}`],
    ["a changed suffix", `${PREFIX}${ADDRESS}${SUFFIX.slice(0, -2)}f4`],
    ["a missing byte", (PREFIX + ADDRESS + SUFFIX).slice(0, -2)],
    ["a trailing byte", `${PREFIX}${ADDRESS}${SUFFIX}00`],
    ["a shortened vanity address", `${PREFIX}${ADDRESS.slice(2)}${SUFFIX}`],
    ["empty bytecode", ""],
  ])("does not recognise %s", (_, hex) => {
    expect(matchErc1167Clone(bytes(hex))).toEqual({ kind: "none_recognized" });
  });
});
