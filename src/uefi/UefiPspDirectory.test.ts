import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { Budget } from "../domain/budget.js";
import { scanPspDirectories } from "./UefiPspDirectory.js";

function table(magic: "$PSP" | "$PL2"): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write(magic, 0, "ascii");
  bytes.writeUInt32LE(0x000c0001, 4);
  bytes.writeUInt32LE(1, 8);
  return bytes;
}

it("distinguishes an unreadable directory header from a truncated entry array", () => {
  const partialEntries = table("$PL2").subarray(0, 16);
  const partialHeader = table("$PSP").subarray(0, 9);
  expect(
    scanPspDirectories(
      Buffer.concat([partialEntries, Buffer.alloc(6), partialHeader]),
      () => true,
    ),
  ).toEqual({
    tables: [],
    candidates: [
      { offset: 0, magic: "$PL2", reason: "truncated-entries" },
      { offset: 22, magic: "$PSP", reason: "truncated-header" },
    ],
  });
});

it("uses the record budget in image order and charges entries only for confirmed directories", () => {
  const rejected = Buffer.alloc(16 + 16 * 255);
  rejected.write("$PSP", 0, "ascii");
  rejected.writeUInt32LE(255, 8);
  const image = Buffer.concat([table("$PL2"), rejected, table("$PSP")]);
  const budget = new Budget(5);
  const result = scanPspDirectories(image, (count = 1) =>
    budget.tryCharge(count),
  );
  expect(
    result.tables.map(({ tableMagic, offset }) => [tableMagic, offset]),
  ).toEqual([
    ["$PL2", 0],
    ["$PSP", 32 + rejected.length],
  ]);
  expect(result.candidates).toEqual([
    { offset: 32, magic: "$PSP", reason: "checksum-mismatch" },
  ]);
});

it("retains the raw PSP fuse-chain value without presenting a declared address", () => {
  const bytes = table("$PSP");
  bytes.writeUInt32LE(0x49341240, 4);
  bytes.writeUInt8(0x0b, 16);
  bytes.writeUInt32LE(0xffffffff, 20);
  bytes.writeBigUInt64LE(0x1234n, 24);
  const result = scanPspDirectories(bytes, () => true);
  expect(result.tables[0]?.entries).toMatchObject([
    {
      type: 0x0b,
      declaredLocation: null,
      declaredLocationRaw: "0x0000000000001234",
      declaredSize: 0xffffffff,
    },
  ]);
});
