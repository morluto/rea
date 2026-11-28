import { describe, expect, it } from "vitest";

import {
  deriveProxyFacts,
  followProxyChain,
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

const account = (byte: string) => `0x${byte.repeat(20)}`;
const node = (byte: string, to?: string, block = 100) =>
  deriveProxyFacts(
    bytes(""),
    inspectEvmProxyInputSchema.parse({
      path: "/a.hex",
      encoding: "hex",
      snapshot: {
        chain_id: 1,
        block,
        account: account(byte),
        slots: to === undefined ? {} : { implementation: word(account(to)) },
      },
    }).snapshot,
  );

describe("proxy chains", () => {
  const summary = (...args: Parameters<typeof followProxyChain>) =>
    followProxyChain(...args).chain.map(({ source, to, status }) => [
      source,
      to,
      status,
    ]);

  it("follows supplied accounts to a missing target", () => {
    expect(summary(node("aa", "bb"), [node("bb", "cc")])).toEqual([
      [account("aa"), account("bb"), "supplied"],
      [account("bb"), account("cc"), "not_supplied"],
    ]);
  });

  it.each([
    ["itself", node("aa", "aa"), []],
    ["an earlier account", node("aa", "bb"), [node("bb", "aa")]],
  ])("stops at a cycle back to %s", (_, root, related) => {
    expect(summary(root, related).at(-1)?.[2]).toBe("cycle");
  });

  it("does not join snapshots from another block", () => {
    const result = followProxyChain(node("aa", "bb"), [node("bb", "cc", 101)]);
    expect(result.chain.map(({ status }) => status)).toEqual([
      "snapshot_mismatch",
    ]);
    expect(result.reached).toEqual([false]);
  });

  it("expands a shared target once without calling it a cycle", () => {
    const root = deriveProxyFacts(bytes(PREFIX + "bb".repeat(20) + SUFFIX), {
      chain_id: 1,
      block: 100,
      account: account("aa"),
      slots: { implementation: word(account("bb")) },
    });
    expect(summary(root, [node("bb", "cc")]).map((row) => row[2])).toEqual([
      "supplied",
      "not_supplied",
      "supplied",
    ]);
  });

  it("walks a long chain without recursion limits", () => {
    const id = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;
    const facts = (index: number) =>
      deriveProxyFacts(bytes(""), {
        chain_id: 1,
        block: 100,
        account: id(index),
        slots: { implementation: word(id(index + 1)) },
      });
    const related = Array.from({ length: 20_000 }, (_, i) => facts(i + 2));
    expect(followProxyChain(facts(1), related).chain).toHaveLength(20_001);
  });
});

describe("related inputs", () => {
  const entry = (byte: string) => ({
    path: "/b.hex",
    encoding: "hex",
    snapshot: { chain_id: 1, block: 100, account: account(byte), slots: {} },
  });
  const parse = (extra: Record<string, unknown>) =>
    inspectEvmProxyInputSchema.safeParse({
      path: "/a.hex",
      encoding: "hex",
      ...extra,
    }).success;

  it("requires a root snapshot", () => {
    expect(parse({ related: [entry("bb")] })).toBe(false);
  });

  it("rejects two artifacts for one account at one block", () => {
    const { snapshot } = entry("aa");
    expect(parse({ snapshot, related: [entry("bb"), entry("BB")] })).toBe(
      false,
    );
    expect(parse({ snapshot, related: [entry("aa")] })).toBe(false);
    expect(parse({ snapshot, related: [entry("bb")] })).toBe(true);
  });
});
