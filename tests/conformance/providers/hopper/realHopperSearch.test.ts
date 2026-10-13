import { expect, it } from "vitest";

import { verifyHopperStringObjects } from "../../../../scripts/lib/real-hopper-search.mjs";

const value = "REA_UTF8_é_😀";
const address = "0x402020";
const bytes = Buffer.from(`${value}\0`);
const item = {
  address,
  value,
  string: {
    encoding: "utf-8",
    encoding_status: "inferred" as const,
    termination: "present_or_not_required" as const,
    byte_length: bytes.length,
  },
};
const expectation = {
  value,
  encoding: "utf-8",
  symbol: "rea_utf8_literal",
  recognitionOptional: true,
};

it("keeps source identity and unknown decoding when the same text exists elsewhere", async () => {
  const report = await verifyHopperStringObjects(
    fixtureCall(),
    [expectation],
    [{ ...item, address: "0x403000" }],
  );
  expect(report.recognition).toEqual([
    { value, address, state: "not_observed", decodedObject: "unverified" },
  ]);
});

it("reuses source bytes and inventory while checking real address filters and searches", async () => {
  const calls: string[] = [];
  const report = await verifyHopperStringObjects(
    fixtureCall(calls),
    [expectation],
    [item],
  );
  expect(report.recognition).toEqual([
    { value, address, state: "observed", decodedObject: "verified" },
  ]);
  expect(calls).toEqual([
    "read_bytes:rea_utf8_literal",
    `list_strings:${address}`,
    `search_strings:${value}`,
    "search_strings:\\xC3\\xA9",
  ]);
});

it.each([
  ["changed source bytes", { bytes_hex: "00" }, item],
  ["incomplete source read", { complete: false }, item],
  ["wrong decoded value", {}, { ...item, value: "wrong" }],
  [
    "wrong decoded extent",
    {},
    { ...item, string: { ...item.string, byte_length: 1 } },
  ],
])(
  "rejects %s even when native recognition is optional",
  async (_label, override, decoded) => {
    await expect(
      verifyHopperStringObjects(
        fixtureCall([], override),
        [expectation],
        [decoded],
      ),
    ).rejects.toThrow();
  },
);

function fixtureCall(
  calls: string[] = [],
  override: Record<string, unknown> = {},
) {
  return async (name: string, arguments_: Record<string, unknown> = {}) => {
    calls.push(
      `${name}:${String(arguments_.address ?? arguments_.pattern ?? "")}`,
    );
    if (name === "read_bytes")
      return {
        address,
        bytes_hex: bytes.toString("hex"),
        complete: true,
        ...override,
      };
    if (name === "list_strings" && arguments_.address === address)
      return [item];
    if (name === "search_strings")
      return arguments_.pattern === value ? [item] : [];
    throw new Error(`Unmodeled verifier call: ${name}`);
  };
}
