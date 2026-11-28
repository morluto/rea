import { describe, expect, it } from "vitest";

import {
  deriveProxyFacts,
  inspectEvmProxyInputSchema,
  matchErc1167Clone,
} from "./evmProxy.js";

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

const ACCOUNT = `0x${"11".repeat(20)}`;
const TARGET = `0x${"22".repeat(20)}`;
const word = (address: string) => `0x${"00".repeat(12)}${address.slice(2)}`;
const ZERO = `0x${"00".repeat(32)}`;
const snapshot = (slots: Record<string, string>) =>
  inspectEvmProxyInputSchema.parse({
    path: "/a.hex",
    encoding: "hex",
    snapshot: { chain_id: 1, block: 100, account: ACCOUNT, slots },
  }).snapshot;

describe("ERC-1967 supplied slots", () => {
  it("keeps unavailable distinct from observed zero", () => {
    const { slots, edges } = deriveProxyFacts(
      bytes(""),
      snapshot({ admin: ZERO }),
    );
    expect(slots.implementation).toMatchObject({ status: "unavailable" });
    expect(slots.admin).toMatchObject({ status: "zero", value: ZERO });
    expect(edges).toEqual([]);
  });

  it("reports every slot unavailable without a snapshot", () => {
    const { slots } = deriveProxyFacts(bytes(""), undefined);
    expect(Object.values(slots).map(({ status }) => status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  it("uses the ERC-1967 storage positions", () => {
    const { slots } = deriveProxyFacts(bytes(""), undefined);
    expect(slots.implementation.slot).toBe(
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    );
    expect(slots.admin.slot).toBe(
      "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
    );
    expect(slots.beacon.slot).toBe(
      "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    );
  });

  it("infers implementation and beacon edges but none for the admin", () => {
    const { slots, edges } = deriveProxyFacts(
      bytes(""),
      snapshot({
        implementation: word(TARGET),
        admin: word(ACCOUNT),
        beacon: word(TARGET),
      }),
    );
    expect(slots.admin).toMatchObject({ status: "address", address: ACCOUNT });
    expect(edges).toEqual([
      {
        relation: "implementation",
        evidence: "erc1967_implementation_slot",
        from: ACCOUNT,
        to: TARGET,
      },
      {
        relation: "beacon",
        evidence: "erc1967_beacon_slot",
        from: ACCOUNT,
        to: TARGET,
      },
    ]);
  });

  it("does not read an address from a word with high bytes set", () => {
    const raw = `0x01${"00".repeat(11)}${"22".repeat(20)}`;
    const { slots, edges } = deriveProxyFacts(
      bytes(""),
      snapshot({ implementation: raw }),
    );
    expect(slots.implementation).toMatchObject({
      status: "not_an_address",
      value: raw,
    });
    expect(edges).toEqual([]);
  });

  it("does not attribute a bytecode match to the snapshot account", () => {
    const { edges } = deriveProxyFacts(
      bytes(PREFIX + ADDRESS + SUFFIX),
      snapshot({}),
    );
    expect(edges).toEqual([
      {
        relation: "implementation",
        evidence: "erc1167_bytecode",
        from: null,
        to: `0x${ADDRESS}`,
      },
    ]);
  });

  it.each([`0x${"00".repeat(31)}`, "00".repeat(32), `0x${"gg".repeat(32)}`])(
    "rejects the malformed slot word %s",
    (value) => {
      expect(() => snapshot({ implementation: value })).toThrow();
    },
  );
});
