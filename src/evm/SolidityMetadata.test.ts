import { expect, it } from "vitest";
import { inspectSolidityMetadata } from "./SolidityMetadata.js";

const bytecode = (hex: string) => {
  const payload = Buffer.from(hex, "hex");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length);
  return Buffer.concat([Buffer.from("00", "hex"), payload, length]);
};

it("reads a compiler version from actual trailer bytes without a magic-prefix assumption", () => {
  const result = inspectSolidityMetadata(bytecode("a164736f6c634300081e"));
  expect(result).toMatchObject({
    status: "decoded",
    bytecode_offset: 1,
    cbor_bytes: 10,
    compiler_version: { representation: "release-bytes", value: "0.8.30" },
    entries: [
      {
        key: { kind: "text", value: "solc" },
        value: { kind: "bytes", value: "00081e" },
      },
    ],
  });
});

it("preserves integer and non-text key precision beyond Number", () => {
  expect(
    inspectSolidityMetadata(bytecode("a1011bffffffffffffffff")).entries,
  ).toEqual([
    {
      key: { kind: "integer", value: "1" },
      value: { kind: "integer", value: "18446744073709551615" },
    },
  ]);
  expect(
    inspectSolidityMetadata(bytecode("a1003bffffffffffffffff")).entries[0]
      ?.value,
  ).toEqual({
    kind: "integer",
    value: "-18446744073709551616",
  });
});

it("retains opaque nested values as partial rather than fabricating scalar values", () => {
  expect(inspectSolidityMetadata(bytecode("a161788100"))).toMatchObject({
    status: "partial",
    entries: [
      {
        key: { kind: "text", value: "x" },
        value: { kind: "uninterpreted", container: "array" },
      },
    ],
  });
});

it("preserves a UTF-8 BOM inside a CBOR text value rather than stripping it", () => {
  expect(
    inspectSolidityMetadata(bytecode("a1617864efbbbf61")).entries[0]?.value,
  ).toEqual({
    kind: "text",
    value: "\ufeffa",
  });
  expect(
    inspectSolidityMetadata(bytecode("a167efbbbf736f6c634300081e"))
      .compiler_version,
  ).toBeNull();
});

it.each([
  ["invalid text", "a1617861ff"],
  ["truncated value", "a16178"],
  ["unsupported tag", "a16178c000"],
  ["floating point", "a16178fa3f800000"],
  ["duplicate key", "a2617801617802"],
  ["excessive nesting", "a16178" + "81".repeat(65) + "00"],
  ["impossible collection", "a161788a00"],
])("keeps exact ranges and unavailable interpretation for %s", (_name, hex) => {
  expect(inspectSolidityMetadata(bytecode(hex))).toMatchObject({
    status: "not-decoded",
    bytecode_offset: 1,
    entries: [],
    compiler_version: null,
  });
});

it.each(["", "60006000f3", "000000", "00010001"])(
  "does not claim absent Solidity metadata for an unavailable trailer: %s",
  (hex) =>
    expect(inspectSolidityMetadata(Buffer.from(hex, "hex"))).toMatchObject({
      status: "unavailable",
      bytecode_offset: null,
      cbor_bytes: null,
      entries: [],
    }),
);
